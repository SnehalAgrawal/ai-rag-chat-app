// Finds the chunks of a collection that answer a question.
//
//   vector    cosine similarity of the question's embedding to every chunk's
//   keyword   BM25 over the chunk text (only chunks sharing a word with the question)
//   rrf       reciprocal rank fusion of the two (k = 60): the default, because in
//             rag-engineering's measurements it found the most evidence at small budgets
//   weighted  alpha × vector + (1 − alpha) × keyword, each min-max normalised (alpha 0.8)
//
// Chunks are returned in rank order until the token budget is used; a chunk that does not
// fit what is left is skipped, as in the measurements this is checked against.
//
// With a reranker, only the first stage's top `candidates` are kept, reordered by the
// reranker's scores (ties keep their first-stage order), and the budget is filled from
// that order; a chunk outside the candidates is never used.
//
// Search is exact (every chunk is scored), filtered to one collection before scoring. At
// the size of a document collection that is fast, and it avoids the trap measured in the
// vector-database article: filtering after an approximate search lost most results.

import { BM25 } from "./keyword.js";
import { cosine, rank, rerankOrder, rrf, weighted, withinBudget } from "./rank.js";

export const METHODS = ["vector", "keyword", "rrf", "weighted"];

export class Retriever {
  /**
   * @param {object} options
   * @param {import("../store/store.js").Store} options.store
   * @param {string} options.collection
   * @param {import("../providers/types.js").EmbeddingProvider} options.embeddings
   */
  constructor({ store, collection, embeddings, analyzer = "words", k1 = 1.2, b = 0.75, rrfK = 60, alpha = 0.8 }) {
    Object.assign(this, { store, collection, embeddings, analyzer, k1, b, rrfK, alpha });
    this.chunks = [];
  }

  /**
   * Embeds chunks that have no embedding from the current model, and builds the keyword
   * index. Call again after documents change.
   */
  async prepare({ signal } = {}) {
    const stale = this.store.chunks(this.collection).filter((c) => !c.embedding || c.embeddingModel !== this.embeddings.name);
    if (stale.length) {
      const vectors = await this.embeddings.embed(stale.map((c) => c.text), { kind: "document", signal });
      this.store.setEmbeddings(this.embeddings.name, stale.map((c, i) => ({ id: c.id, vector: vectors[i] })));
    }
    this.chunks = this.store.chunks(this.collection);
    this.keyword = new BM25(this.chunks.map((c) => c.text), { analyzer: this.analyzer, k1: this.k1, b: this.b });
    return { chunks: this.chunks.length, embedded: stale.length };
  }

  /** Vector and keyword scores for every chunk, with the time each took. */
  async scores(question, { signal } = {}) {
    if (!this.keyword) throw new Error("Retriever.prepare() has not been run");
    let started = performance.now();
    const [query] = await this.embeddings.embed([question], { kind: "query", signal });
    const embedMs = performance.now() - started;
    started = performance.now();
    const vector = this.chunks.map((c) => cosine(query, c.embedding));
    const vectorMs = performance.now() - started;
    started = performance.now();
    const keyword = this.keyword.scores(question);
    const keywordMs = performance.now() - started;
    return { vector, keyword, timings: { embedMs, vectorMs, keywordMs } };
  }

  /** Chunk indexes, best first, for one method. */
  ranking(method, { vector, keyword }) {
    if (method === "vector") return rank(vector);
    if (method === "keyword") return rank(keyword, true);
    if (method === "rrf") return rank(rrf([rank(vector), rank(keyword, true)], this.rrfK, this.chunks.length));
    if (method === "weighted") return rank(weighted(vector, keyword, this.alpha), true);
    throw new Error(`Unknown retrieval method "${method}"; one of ${METHODS.join(", ")}`);
  }

  /**
   * The chunks to give the model for a question.
   * @returns {Promise<{ chunks: object[], tokens: number, timings: object }>}
   */
  async search(question, { method = "rrf", budget = 1000, rerank = null, signal } = {}) {
    const scores = await this.scores(question, { signal });
    let ranked = this.ranking(method, scores);
    const timings = { ...scores.timings };
    let rerankScores = null;
    if (rerank?.reranker) {
      const candidates = ranked.slice(0, rerank.candidates ?? 10);
      const started = performance.now();
      const values = await rerank.reranker.score(question, candidates.map((i) => this.chunks[i].text), { signal });
      timings.rerankMs = performance.now() - started;
      rerankScores = new Map(candidates.map((index, k) => [index, values[k]]));
      ranked = rerankOrder(candidates, values);
    }
    const chosen = withinBudget(ranked, this.chunks.map((c) => c.tokens), budget);
    const chunks = chosen.map((i, position) => {
      const { embedding, ...chunk } = this.chunks[i];
      return {
        ...chunk,
        rank: position + 1,
        vectorScore: scores.vector[i],
        keywordScore: scores.keyword[i],
        ...(rerankScores ? { rerankScore: rerankScores.get(i) } : {}),
      };
    });
    return { chunks, tokens: chunks.reduce((n, c) => n + c.tokens, 0), timings };
  }
}

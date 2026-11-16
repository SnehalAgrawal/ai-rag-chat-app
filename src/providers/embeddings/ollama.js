// Local embeddings through Ollama's /api/embed.
//
// `truncate: false`: by default Ollama silently cuts input longer than the model's context,
// which in rag-engineering's chunking measurements left the evidence for 9 questions never
// embedded. Here an over-long input is an error instead, so it is noticed.
//
// nomic-embed-text was trained with task prefixes; leaving them out quietly lowers
// retrieval quality, so they are added here ("search_document: " / "search_query: ").

import { joinUrl, postJson } from "../http.js";

const PREFIXES = {
  "nomic-embed-text": { document: "search_document: ", query: "search_query: " },
};

export function prefixesFor(model) {
  return PREFIXES[model.split(":")[0]] ?? { document: "", query: "" };
}

/** @returns {import("../types.js").EmbeddingProvider} */
export function ollamaEmbeddings({ baseUrl = "http://127.0.0.1:11434", model = "nomic-embed-text", batchSize = 32, keepAlive = "10m", timeoutMs = 120_000 } = {}) {
  const prefixes = prefixesFor(model);
  return {
    name: `ollama:${model}`,
    async embed(texts, { kind = "document", signal } = {}) {
      const vectors = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const input = texts.slice(i, i + batchSize).map((t) => prefixes[kind] + t);
        const response = await postJson(
          joinUrl(baseUrl, "/api/embed"),
          { model, input, truncate: false, keep_alive: keepAlive },
          { signal, timeoutMs },
        );
        const { embeddings } = await response.json();
        if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
          throw new Error(`ollama embeddings: expected ${input.length} vectors, got ${embeddings?.length ?? "none"}`);
        }
        vectors.push(...embeddings.map((e) => Float32Array.from(e)));
      }
      return vectors;
    },
  };
}

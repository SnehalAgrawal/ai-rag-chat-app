// The application: collections of documents, and questions answered from them. The HTTP
// server (src/server.js) is a thin layer over this.

import { createAnswerer } from "./answer/index.js";
import { documentFromBytes, ingest, SUPPORTED } from "./ingest.js";
import { Retriever } from "./retrieval/retriever.js";

export const COLLECTION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DOCUMENT_NAME = /^[\w][\w .()+-]{0,119}$/;

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function checkCollectionName(name) {
  if (!COLLECTION_NAME.test(name ?? "")) {
    throw new UserError("A collection name is 1 to 40 lowercase letters, digits, or hyphens, starting with a letter or digit.");
  }
  return name;
}

export function checkDocumentName(name) {
  const extension = (name ?? "").slice((name ?? "").lastIndexOf(".")).toLowerCase();
  if (!DOCUMENT_NAME.test(name ?? "") || name.includes("..")) {
    throw new UserError("A document name is up to 120 letters, digits, spaces, and . _ ( ) + - characters.");
  }
  if (!SUPPORTED.includes(extension)) throw new UserError(`Supported files: ${SUPPORTED.join(", ")}.`, 415);
  return name;
}

export class App {
  /**
   * @param {object} deps
   * @param {ReturnType<import("./config.js").loadConfig>} deps.config
   * @param {import("./store/store.js").Store} deps.store
   * @param {import("./providers/types.js").EmbeddingProvider} deps.embeddings
   * @param {import("./providers/types.js").LLMProvider} deps.llm
   * @param {import("./rerank/types.js").Reranker | null} deps.reranker
   * @param {{ count(text: string): number }} deps.tokenizer
   */
  constructor({ config, store, embeddings, llm, reranker, tokenizer }) {
    Object.assign(this, { config, store, embeddings, llm, reranker, tokenizer });
    this.retrievers = new Map();
  }

  status() {
    return {
      llm: this.llm.name,
      embeddings: this.embeddings.name,
      reranker: this.reranker?.name ?? null,
      retrieval: this.config.retrieval,
      answers: this.config.answers,
      exactTokens: Boolean(this.tokenizer.exact),
      supported: SUPPORTED,
    };
  }

  collections() {
    return this.store.collections();
  }

  createCollection(name) {
    checkCollectionName(name);
    this.store.collection(name);
    return { name };
  }

  documents(collection) {
    checkCollectionName(collection);
    return this.store.documents(collection);
  }

  document(collection, name) {
    checkCollectionName(collection);
    const document = this.store.document(collection, name);
    if (!document) throw new UserError(`No document "${name}" in "${collection}".`, 404);
    return { name: document.name, text: document.text, addedAt: document.added_at };
  }

  /** Adds (or replaces) a document, then embeds its new chunks so it can be searched at once. */
  async addDocument(collection, name, bytes) {
    checkCollectionName(collection);
    checkDocumentName(name);
    let document;
    try {
      document = await documentFromBytes(name, bytes);
    } catch (error) {
      throw new UserError(error.message, 422);
    }
    const result = ingest(this.store, collection, [document], this.tokenizer);
    if (result.empty.length) throw new UserError(`${name} has no text.`, 422);
    const outcome = result.added.length ? "added" : result.updated.length ? "updated" : "unchanged";
    const { embedded } = await this.refresh(collection);
    const chunks = this.store.documents(collection).find((d) => d.name === name)?.chunks ?? 0;
    return { name, outcome, chunks, embedded };
  }

  async deleteDocument(collection, name) {
    checkCollectionName(collection);
    if (!this.store.deleteDocument(collection, name)) throw new UserError(`No document "${name}" in "${collection}".`, 404);
    await this.refresh(collection);
    return { name, deleted: true };
  }

  /** The collection's retriever, prepared (chunks embedded, keyword index built). */
  async retriever(collection) {
    if (!this.retrievers.has(collection)) await this.refresh(collection);
    return this.retrievers.get(collection);
  }

  async refresh(collection) {
    const retriever = new Retriever({ store: this.store, collection, embeddings: this.embeddings });
    const prepared = await retriever.prepare();
    this.retrievers.set(collection, retriever);
    return prepared;
  }

  /**
   * Answers a question from a collection.
   * @param {{ history?: object[], signal?: AbortSignal, onStage?: (event: object) => void }} [options]
   */
  async ask(collection, question, { history = [], signal, onStage } = {}) {
    checkCollectionName(collection);
    if (typeof question !== "string" || !question.trim()) throw new UserError("Ask a question.");
    if (question.length > 2000) throw new UserError("A question is at most 2,000 characters.");
    const retriever = await this.retriever(collection);
    if (!retriever.chunks.length) throw new UserError(`"${collection}" has no documents yet. Add some first.`, 409);
    const answerer = createAnswerer({ config: this.config, retriever, llm: this.llm, reranker: this.reranker, embeddings: this.embeddings });
    return answerer.ask(question.trim(), { history: cleanHistory(history), signal, onStage });
  }
}

/** Only user and assistant turns with text, the last 6. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-6);
}

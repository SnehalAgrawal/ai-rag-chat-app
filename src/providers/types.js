// The interfaces every provider implements; configuration picks the implementation, so
// the local models and OpenAI or Claude are interchangeable.

/**
 * @typedef {object} LLMProvider
 * @property {string} name
 * @property {(messages: { role: string, content: string }[], options?: { signal?: AbortSignal }) => AsyncIterable<string>} stream
 *   Streams the reply's text. A "system" message, if any, comes first.
 * @property {(messages: { role: string, content: string }[], options?: { schema?: object, signal?: AbortSignal }) => Promise<{ text: string, stopReason?: string, usage?: { inputTokens?: number, outputTokens?: number } }>} complete
 *   One whole reply; with a JSON schema, the reply is JSON that matches it.
 */

/**
 * Turns texts into vectors. `kind` matters for models trained with different prefixes for
 * documents and for search queries (nomic-embed-text); others ignore it.
 *
 * @typedef {object} EmbeddingProvider
 * @property {string} name  stored with every vector, so vectors from different models are never mixed
 * @property {(texts: string[], options?: { kind?: "document" | "query", signal?: AbortSignal }) => Promise<Float32Array[]>} embed
 */

export {};

/**
 * Scores passages for a question; higher means more relevant. Scores are only compared
 * within one question, so they need not be calibrated.
 *
 * @typedef {object} Reranker
 * @property {string} name
 * @property {(question: string, passages: string[], options?: { signal?: AbortSignal }) => Promise<number[]>} score
 */

export {};

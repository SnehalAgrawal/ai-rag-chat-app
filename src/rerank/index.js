// Picks the reranker from the configuration.

import { crossEncoderReranker } from "./cross-encoder.js";
import { llmJudgeReranker } from "./llm-judge.js";

/** @returns {Promise<import("./types.js").Reranker | null>} null when reranking is off */
export async function createReranker(retrieval, { ollamaBaseUrl } = {}) {
  if (retrieval.reranker === "none") return null;
  if (retrieval.reranker === "llm-judge") return llmJudgeReranker(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {});
  return crossEncoderReranker({ model: retrieval.reranker, precision: retrieval.rerankPrecision });
}

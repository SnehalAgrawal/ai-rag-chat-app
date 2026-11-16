// Picks each stage's provider from the configuration.

import { openAICompatibleEmbeddings } from "./embeddings/openai-compatible.js";
import { ollamaEmbeddings } from "./embeddings/ollama.js";
import { anthropicLLM } from "./llm/anthropic.js";
import { ollamaLLM } from "./llm/ollama.js";
import { openAICompatibleLLM } from "./llm/openai-compatible.js";

const LLMS = { ollama: ollamaLLM, "openai-compatible": openAICompatibleLLM, anthropic: anthropicLLM };
const EMBEDDINGS = { ollama: ollamaEmbeddings, "openai-compatible": openAICompatibleEmbeddings };

/** Drops undefined settings so each provider's own defaults apply. */
const defined = (config) => Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));

/** @returns {import("./types.js").LLMProvider} */
export function createLLM(config) {
  return pick(LLMS, "LLM", config.provider)(defined(config));
}

/** @returns {import("./types.js").EmbeddingProvider} */
export function createEmbeddings(config) {
  return pick(EMBEDDINGS, "embedding", config.provider)(defined(config));
}

function pick(table, stage, provider) {
  const factory = table[provider];
  if (!factory) throw new Error(`Unknown ${stage} provider: ${provider}`);
  return factory;
}

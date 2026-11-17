// All settings come from environment variables (see .env.example). The defaults run
// everything locally with no accounts or keys; OpenAI and Claude are a provider name and
// a key away.

const LLM_DEFAULTS = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: undefined },
  anthropic: { baseUrl: undefined, model: "claude-opus-5-5" },
};

const EMBEDDING_DEFAULTS = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
};

export function loadConfig(env = process.env) {
  const llmProvider = choice(env, "LLM_PROVIDER", Object.keys(LLM_DEFAULTS), "ollama");
  const embeddingProvider = choice(env, "EMBEDDING_PROVIDER", Object.keys(EMBEDDING_DEFAULTS), "ollama");
  return {
    databasePath: env.DATABASE_PATH || "data/app.db",
    port: integer(env, "PORT") ?? 3000,
    // Local only by default: there are no accounts.
    host: env.HOST || "127.0.0.1",
    maxUploadMB: integer(env, "MAX_UPLOAD_MB") ?? 20,
    llm: {
      provider: llmProvider,
      baseUrl: env.LLM_BASE_URL || LLM_DEFAULTS[llmProvider].baseUrl,
      model: env.LLM_MODEL || LLM_DEFAULTS[llmProvider].model,
      apiKey: env.LLM_API_KEY || undefined,
      // 0 by default: answers should follow the documents, and runs should repeat.
      // Ignored by Claude, whose current models reject sampling parameters.
      temperature: number(env, "LLM_TEMPERATURE") ?? 0,
      seed: integer(env, "LLM_SEED"),
      // Each provider has its own default (1,024; 16,000 for Claude, whose thinking counts against it).
      maxTokens: integer(env, "LLM_MAX_TOKENS"),
      numCtx: integer(env, "LLM_NUM_CTX"),
      // Claude only: thinking depth.
      effort: env.LLM_EFFORT ? choice(env, "LLM_EFFORT", ["low", "medium", "high", "xhigh", "max"]) : undefined,
    },
    retrieval: retrievalSettings(env),
    // As measured on the development questions (see the README): numbered citations (quotes
    // cited the evidence more often but invented more answers to unanswerable questions),
    // follow-ups rewritten, and no relevance gate (it never caught an unanswerable question
    // the model would have answered, and the reranker-score gate blocked answerable ones).
    answers: {
      citations: choice(env, "CITATIONS", ["numbers", "quotes"], "numbers"),
      rewrite: boolean(env, "REWRITE", true),
      gate: choice(env, "GATE", ["off", "vector", "rerank"], "off"),
    },
    embeddings: {
      provider: embeddingProvider,
      baseUrl: env.EMBEDDING_BASE_URL || EMBEDDING_DEFAULTS[embeddingProvider].baseUrl,
      model: env.EMBEDDING_MODEL || EMBEDDING_DEFAULTS[embeddingProvider].model,
      apiKey: env.EMBEDDING_API_KEY || undefined,
    },
  };
}

/**
 * Retrieval as measured (see the README): with a reranker, vector search's top 10 candidates
 * reranked; without one, RRF. Reranking RRF's candidates made results slightly worse.
 */
function retrievalSettings(env) {
  const reranker = choice(env, "RERANKER", ["mxbai-rerank-xsmall-v1", "llm-judge", "none"], "mxbai-rerank-xsmall-v1");
  return {
    reranker,
    rerankPrecision: choice(env, "RERANK_PRECISION", ["fp32", "q8"], "fp32"),
    candidates: integer(env, "RERANK_CANDIDATES") ?? 10,
    method: env.RETRIEVAL_METHOD ? choice(env, "RETRIEVAL_METHOD", ["vector", "keyword", "rrf", "weighted"]) : reranker === "none" ? "rrf" : "vector",
    budget: integer(env, "RETRIEVAL_BUDGET") ?? 1000,
  };
}

/** Loads `.env` from the working directory if there is one. */
export function loadEnvFile(path = ".env") {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function choice(env, name, allowed, fallback) {
  const value = env[name] || fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  return value;
}

function boolean(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false (got "${env[name]}")`);
}

function number(env, name) {
  if (env[name] === undefined || env[name] === "") return undefined;
  const value = Number(env[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${env[name]}")`);
  return value;
}

function integer(env, name) {
  const value = number(env, name);
  if (value !== undefined && !Number.isInteger(value)) throw new Error(`${name} must be a whole number (got "${env[name]}")`);
  return value;
}

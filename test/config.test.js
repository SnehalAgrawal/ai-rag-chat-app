import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createEmbeddings, createLLM } from "../src/providers/index.js";

test("defaults run everything locally, with no keys", () => {
  const config = loadConfig({});
  assert.equal(config.databasePath, "data/app.db");
  assert.equal(createLLM(config.llm).name, "ollama:llama3.2:3b");
  assert.equal(createEmbeddings(config.embeddings).name, "ollama:nomic-embed-text");
  assert.equal(config.llm.apiKey, undefined);
});

test("OpenAI for answers and embeddings is two providers and two keys", () => {
  const config = loadConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_MODEL: "gpt-4o-mini",
    LLM_API_KEY: "sk-a",
    EMBEDDING_PROVIDER: "openai-compatible",
    EMBEDDING_API_KEY: "sk-b",
  });
  assert.equal(createLLM(config.llm).name, "openai-compatible:gpt-4o-mini");
  assert.equal(config.llm.baseUrl, "https://api.openai.com/v1");
  assert.equal(createEmbeddings(config.embeddings).name, "openai-compatible:text-embedding-3-small");
});

test("Claude for answers defaults to Claude Opus 5.5; effort is optional and checked", () => {
  const config = loadConfig({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant" });
  assert.equal(createLLM(config.llm).name, "anthropic:claude-opus-5-5");
  assert.equal(config.llm.effort, undefined, "the provider's default applies");
  assert.equal(loadConfig({ LLM_PROVIDER: "anthropic", LLM_EFFORT: "high" }).llm.effort, "high");
  assert.throws(() => loadConfig({ LLM_EFFORT: "extreme" }), /LLM_EFFORT must be one of/);
});

test("invalid settings are rejected with the variable's name", () => {
  assert.throws(() => loadConfig({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER must be one of ollama, openai-compatible, anthropic/);
  assert.throws(() => loadConfig({ EMBEDDING_PROVIDER: "anthropic" }), /EMBEDDING_PROVIDER must be one of ollama, openai-compatible/);
  assert.throws(() => loadConfig({ LLM_SEED: "1.5" }), /LLM_SEED must be a whole number/);
});

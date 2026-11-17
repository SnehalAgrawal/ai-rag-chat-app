// Builds the answer pipeline from the configuration.

import { readFileSync } from "node:fs";
import { Answerer } from "./answerer.js";

const GATE = JSON.parse(readFileSync(new URL("./gate.json", import.meta.url), "utf8")).thresholds;

/**
 * The tuned gate for the current models, or null when the gate is off.
 * @param {"off" | "vector" | "rerank"} kind
 */
export function gateFor(kind, { embeddings, reranker }) {
  if (kind === "off") return null;
  const source = kind === "vector" ? embeddings?.name : reranker?.name;
  if (!source) throw new Error(`GATE=${kind} needs ${kind === "vector" ? "an embedding model" : "a reranker"}`);
  const tuned = GATE[`${kind}:${source}`];
  if (!tuned) {
    throw new Error(`GATE=${kind}: no threshold has been tuned for ${source}. Run npm run tune:gate with these models, or set GATE=off.`);
  }
  return { signal: kind, threshold: tuned.threshold };
}

export function createAnswerer({ config, retriever, llm, reranker, embeddings }) {
  return new Answerer({
    retriever,
    llm,
    reranker,
    retrieval: config.retrieval,
    gate: gateFor(config.answers.gate, { embeddings, reranker }),
    rewrite: config.answers.rewrite,
    citations: config.answers.citations,
  });
}

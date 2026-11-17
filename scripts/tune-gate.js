// Chooses the relevance gate's threshold on the development questions, then reports it on
// the test questions.
//
//   npm run tune:gate
//
// The rule, fixed before any data was seen (as in rag-engineering 03): the highest threshold
// that blocks at most 1% of the answerable development questions. With 52 of them, that is
// none: the threshold is the lowest best-score among them. It is chosen separately for each
// signal: the best reranker score (the default setup) and the best vector similarity (when
// reranking is off). Writes src/answer/gate.json.

import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { loadQuestions } from "../src/evaluation/evidence.js";
import { openEvalCollection } from "../src/evaluation/setup.js";
import { createEmbeddings } from "../src/providers/index.js";
import { crossEncoderReranker } from "../src/rerank/cross-encoder.js";
import { loadTokenizer } from "../src/text/tokens.js";

loadEnvFile();
const config = loadConfig();
const embeddings = createEmbeddings(config.embeddings);
const { store, retriever } = await openEvalCollection({ tokenizer: loadTokenizer(), embeddings });
const reranker = await crossEncoderReranker({ precision: config.retrieval.rerankPrecision });
const notInDocs = JSON.parse(readFileSync(new URL("../eval/questions/not-in-docs.json", import.meta.url), "utf8")).questions;
const answerable = Object.values(loadQuestions()).flat();

/** The best score each setup would see for a question. */
async function signals(question) {
  const { best } = await retriever.search(question, { method: "vector", budget: 1000, rerank: { reranker, candidates: config.retrieval.candidates } });
  return best;
}

const rows = [];
for (const q of answerable) rows.push({ id: q.id, split: q.split, answerable: true, ...(await signals(q.question)) });
for (const q of notInDocs) rows.push({ id: q.id, split: q.split, answerable: false, ...(await signals(q.question)) });

const SOURCES = { rerank: reranker.name, vector: embeddings.name };
const gate = { _comment: "Relevance-gate thresholds, written by scripts/tune-gate.js. Rule: the highest threshold that blocks at most 1% of the answerable development questions (rag-engineering 03's rule). A question is declined without asking the model when its best score is below the threshold.", thresholds: {} };
for (const signal of ["rerank", "vector"]) {
  const dev = rows.filter((r) => r.split === "dev");
  const answerableDev = dev.filter((r) => r.answerable).map((r) => r[signal]).sort((a, b) => a - b);
  const allowed = Math.floor(answerableDev.length * 0.01);
  const threshold = answerableDev[allowed];
  const blocked = (split, isAnswerable) => rows.filter((r) => r.split === split && r.answerable === isAnswerable && r[signal] < threshold);
  const count = (split, isAnswerable) => rows.filter((r) => r.split === split && r.answerable === isAnswerable).length;
  const key = `${signal}:${SOURCES[signal]}`;
  gate.thresholds[key] = {
    // Exact, not rounded: rounding up would block the question the threshold was taken from.
    threshold,
    chosenOn: `${answerableDev.length} answerable and ${count("dev", false)} not-in-docs development questions`,
    date: new Date().toISOString().slice(0, 10),
  };
  console.log(`\n${key}: threshold ${threshold.toFixed(4)}`);
  for (const split of ["dev", "test"]) {
    const wrong = blocked(split, true);
    console.log(`  ${split}: blocks ${blocked(split, false).length} of ${count(split, false)} not-in-docs questions, and ${wrong.length} of ${count(split, true)} answerable${wrong.length ? ` (${wrong.map((r) => r.id).join(", ")})` : ""}`);
  }
  const lowestNot = rows.filter((r) => !r.answerable).map((r) => r[signal]);
  console.log(`  not-in-docs best scores: ${Math.min(...lowestNot).toFixed(3)} to ${Math.max(...lowestNot).toFixed(3)}; answerable: ${Math.min(...rows.filter((r) => r.answerable).map((r) => r[signal])).toFixed(3)} to ${Math.max(...rows.filter((r) => r.answerable).map((r) => r[signal])).toFixed(3)}`);
}
writeFileSync(new URL("../src/answer/gate.json", import.meta.url), `${JSON.stringify(gate, null, 2)}\n`);
writeFileSync(new URL("../results/gate-signals.json", import.meta.url), `${JSON.stringify(rows, null, 1)}\n`);
console.log("\nWrote src/answer/gate.json (and every question's scores to results/gate-signals.json)");
store.close();

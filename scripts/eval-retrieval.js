// Retrieval on the frozen question sets, through this app's own code, next to the numbers
// rag-engineering published for the same documents, chunks, and embedding model
// (05-hybrid-search/README.md at commit d569efa). The two should match.
//
//   npm run eval:retrieval [-- --out results/retrieval.json]
//
// Needs the Llama 3.2 tokenizer (models/tokenizer.json, see the README), so chunks and
// budgets are counted exactly as they were, and Ollama with nomic-embed-text.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { found, loadQuestions } from "../src/evaluation/evidence.js";
import { openEvalCollection } from "../src/evaluation/setup.js";
import { createEmbeddings } from "../src/providers/index.js";
import { BM25 } from "../src/retrieval/keyword.js";
import { rank, withinBudget } from "../src/retrieval/rank.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({ options: { out: { type: "string" }, db: { type: "string", default: "data/eval.db" } } });

/** rag-engineering 05-hybrid-search, "All test questions (48), by budget" and "Evidence found at 1000 tokens". */
const PUBLISHED = {
  testByBudget: {
    vector: [41, 46, 48],
    "keyword-words": [41, 45, 46],
    "keyword-identifiers": [41, 46, 46],
    rrf: [45, 47, 47],
    "weighted-0.8": [43, 46, 48],
  },
  at1000: {
    vector: [18, 17, 31, 29],
    "keyword-words": [13, 17, 29, 28],
    "keyword-identifiers": [13, 17, 29, 29],
    rrf: [19, 18, 30, 29],
    "weighted-0.8": [20, 18, 31, 28],
  },
};
const BUDGETS = [500, 1000, 2000];
const GROUPS = [["new", "dev"], ["new", "test"], ["04", "dev"], ["04", "test"]];

loadEnvFile();
const tokenizer = loadTokenizer();
const config = loadConfig();
const embeddings = createEmbeddings(config.embeddings);

// The documents, ingested into their own database.
let store;
let retriever;
let prepared;
try {
  ({ store, retriever, embedded: prepared } = await openEvalCollection({ dbPath: args.db, tokenizer, embeddings }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const chunks = retriever.chunks;
const tokens = chunks.map((c) => c.tokens);
const identifiers = new BM25(chunks.map((c) => c.text), { analyzer: "identifiers" });
console.log(`${chunks.length} chunks, ${tokens.reduce((a, b) => a + b, 0)} tokens; embedded now: ${prepared} (${embeddings.name})`);

// Every question scored once (questions embedded one at a time, as a live system would).
const sets = loadQuestions();
const rankings = new Map();
const embedMs = [];
for (const question of Object.values(sets).flat()) {
  const scores = await retriever.scores(question.question);
  embedMs.push(scores.timings.embedMs);
  rankings.set(question.id, {
    vector: retriever.ranking("vector", scores),
    "keyword-words": retriever.ranking("keyword", scores),
    "keyword-identifiers": rank(identifiers.scores(question.question), true),
    rrf: retriever.ranking("rrf", scores),
    "weighted-0.8": retriever.ranking("weighted", scores),
  });
}
const foundAt = (question, method, budget) => found(question, withinBudget(rankings.get(question.id)[method], tokens, budget).map((i) => chunks[i].text));
const count = (method, budget, setName, split) => sets[setName].filter((q) => q.split === split && foundAt(q, method, budget)).length;

const methods = Object.keys(PUBLISHED.testByBudget);
const results = { testByBudget: {}, at1000: {} };
let mismatches = 0;
const cell = (ours, published) => {
  if (ours !== published) mismatches++;
  return `${String(ours).padStart(3)}${ours === published ? "  " : ` ≠ ${published}`}`.padEnd(15);
};

console.log("\nEvidence found at 1,000 tokens (this app, then ≠ published where they differ)");
console.log(`${"method".padEnd(22)}${GROUPS.map(([s, p]) => `${s} ${p} (${sets[s].filter((q) => q.split === p).length})`.padEnd(15)).join("")}`);
for (const method of methods) {
  results.at1000[method] = GROUPS.map(([s, p]) => count(method, 1000, s, p));
  console.log(`${method.padEnd(22)}${results.at1000[method].map((n, i) => cell(n, PUBLISHED.at1000[method][i])).join("")}`);
}

const testTotal = Object.values(sets).flat().filter((q) => q.split === "test").length;
console.log(`\nAll test questions (${testTotal}), by budget`);
console.log(`${"method".padEnd(22)}${BUDGETS.map((b) => `${b} tokens`.padEnd(15)).join("")}`);
for (const method of methods) {
  results.testByBudget[method] = BUDGETS.map((b) => count(method, b, "new", "test") + count(method, b, "04", "test"));
  console.log(`${method.padEnd(22)}${results.testByBudget[method].map((n, i) => cell(n, PUBLISHED.testByBudget[method][i])).join("")}`);
}

embedMs.sort((a, b) => a - b);
console.log(`\nEmbedding a question: median ${embedMs[Math.floor(embedMs.length / 2)].toFixed(1)} ms over ${embedMs.length} questions`);
console.log(mismatches === 0 ? "All numbers match the published ones." : `${mismatches} numbers differ from the published ones.`);

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify({ date: new Date().toISOString(), embeddings: embeddings.name, tokenizer: tokenizer.name, chunks: chunks.length, results, published: PUBLISHED, mismatches }, null, 2)}\n`);
}
store.close();
process.exit(mismatches === 0 ? 0 : 1);

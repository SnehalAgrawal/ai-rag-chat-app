// Reranking on the frozen question sets: no reranking, the LLM judge from rag-engineering's
// reranking demo (whose published numbers it should reproduce), and a cross-encoder.
//
//   npm run eval:rerank [-- --rerankers llm-judge,mxbai-q8,mxbai-fp32] [-- --out results/rerank.json]
//
// As in the demo (06-reranking, commit d569efa): every (question, chunk) pair in the top 20
// of either first stage (vector, RRF) is scored once, in sorted order, and the same score is
// used for both stages and both candidate counts. The LLM judge is scored one pair at a time
// from a freshly loaded model, because Ollama's prompt cache can shift a repeated pair's score.
// Needs the Llama 3.2 tokenizer, Ollama (nomic-embed-text, llama3.2:3b), and `npm run models`.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { found, loadQuestions } from "../src/evaluation/evidence.js";
import { openEvalCollection } from "../src/evaluation/setup.js";
import { createEmbeddings } from "../src/providers/index.js";
import { rerankOrder, withinBudget } from "../src/retrieval/rank.js";
import { crossEncoderReranker } from "../src/rerank/cross-encoder.js";
import { llmJudgeReranker } from "../src/rerank/llm-judge.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({
  options: {
    rerankers: { type: "string", default: "llm-judge,mxbai-q8,mxbai-fp32" },
    out: { type: "string" },
    db: { type: "string", default: "data/eval.db" },
  },
});

/** rag-engineering 06-reranking, "Expected output", tables 1 to 3 (the LLM judge). */
const PUBLISHED = {
  pairs: 2581,
  recall: { "vector 10": [20, 19, 31, 29], "vector 20": [21, 19, 31, 29], "rrf 10": [19, 18, 31, 29], "rrf 20": [19, 18, 31, 29] },
  testByBudget: {
    "vector 10 first-stage": [41, 46, 48], "vector 10 llm-judge": [46, 48, 48],
    "vector 20 first-stage": [41, 46, 48], "vector 20 llm-judge": [45, 47, 48],
    "rrf 10 first-stage": [45, 47, 47], "rrf 10 llm-judge": [44, 47, 47],
    "rrf 20 first-stage": [45, 47, 47], "rrf 20 llm-judge": [44, 46, 47],
  },
  at1000: {
    "vector 10 first-stage": [18, 17, 31, 29], "vector 10 llm-judge": [20, 19, 31, 29],
    "vector 20 first-stage": [18, 17, 31, 29], "vector 20 llm-judge": [21, 18, 31, 29],
    "rrf 10 first-stage": [19, 18, 30, 29], "rrf 10 llm-judge": [19, 18, 31, 29],
    "rrf 20 first-stage": [19, 18, 30, 29], "rrf 20 llm-judge": [19, 17, 30, 29],
  },
};
const BUDGETS = [500, 1000, 2000];
const STAGES = ["vector", "rrf"];
const COUNTS = [10, 20];
const GROUPS = [["new", "dev"], ["new", "test"], ["04", "dev"], ["04", "test"]];

loadEnvFile();
const config = loadConfig();
const embeddings = createEmbeddings(config.embeddings);
let store;
let retriever;
try {
  ({ store, retriever } = await openEvalCollection({ dbPath: args.db, tokenizer: loadTokenizer(), embeddings }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const chunks = retriever.chunks;
const tokens = chunks.map((c) => c.tokens);
const sets = loadQuestions();
const questions = Object.entries(sets).flatMap(([set, list]) => list.map((q) => ({ ...q, set })));
const setup = {
  date: new Date().toISOString(),
  power: execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).split("\n")[0],
  ollama: execFileSync("ollama", ["--version"], { encoding: "utf8" }).trim().split("\n").pop().replace(/^.*version is /, ""),
  node: process.version,
};
console.log(`${chunks.length} chunks; ${questions.length} questions; ${setup.power}`);

// First-stage rankings, as in 05 and 06.
const firstStage = new Map();
for (const q of questions) {
  const scores = await retriever.scores(q.question);
  firstStage.set(q.id, { vector: retriever.ranking("vector", scores), rrf: retriever.ranking("rrf", scores) });
}

// Every (question, chunk) pair in the top 20 of either stage, sorted by question id, then chunk index.
const seen = new Set();
const pairs = [];
for (const q of questions) {
  for (const stage of STAGES) {
    for (const i of firstStage.get(q.id)[stage].slice(0, 20)) {
      const key = `${q.id}\u0000${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([q.id, i]);
      }
    }
  }
}
pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
const byId = new Map(questions.map((q) => [q.id, q]));
console.log(`${pairs.length} pairs to score${pairs.length === PUBLISHED.pairs ? " (as published)" : ` (published: ${PUBLISHED.pairs})`}`);

// Score every pair with each reranker.
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const results = { setup, pairs: pairs.length, rerankers: {} };
const scoreTables = {};
for (const id of args.rerankers.split(",")) {
  const table = new Map();
  const info = {};
  if (id === "llm-judge") {
    execFileSync("ollama", ["stop", "llama3.2:3b"], { stdio: "ignore" });
    const judge = llmJudgeReranker();
    const callMs = [];
    const started = performance.now();
    for (const [n, [qid, i]] of pairs.entries()) {
      const t = performance.now();
      const [score] = await judge.score(byId.get(qid).question, [chunks[i].text]);
      callMs.push(performance.now() - t);
      table.set(`${qid}\u0000${i}`, score);
      if ((n + 1) % 500 === 0) console.log(`  llm-judge: ${n + 1} of ${pairs.length} pairs`);
    }
    Object.assign(info, { name: judge.name, totalSeconds: Math.round((performance.now() - started) / 1000), medianCallMs: Math.round(median(callMs)) });
    execFileSync("ollama", ["stop", "llama3.2:3b"], { stdio: "ignore" });
  } else if (id.startsWith("mxbai-")) {
    const reranker = await crossEncoderReranker({ precision: id.slice("mxbai-".length) });
    const byQuestion = new Map();
    for (const [qid, i] of pairs) byQuestion.set(qid, [...(byQuestion.get(qid) ?? []), i]);
    const started = performance.now();
    for (const [qid, indexes] of byQuestion) {
      const scores = await reranker.score(byId.get(qid).question, indexes.map((i) => chunks[i].text));
      indexes.forEach((i, k) => table.set(`${qid}\u0000${i}`, scores[k]));
    }
    const totalSeconds = (performance.now() - started) / 1000;
    // The cost a user would see: one question's candidates scored together (warm model).
    const perQuestion = { 10: [], 20: [] };
    for (const q of questions) {
      for (const n of COUNTS) {
        const passages = firstStage.get(q.id).vector.slice(0, n).map((i) => chunks[i].text);
        const t = performance.now();
        await reranker.score(q.question, passages);
        perQuestion[n].push(performance.now() - t);
      }
    }
    const lengths = pairs.map(([qid, i]) => reranker.countTokens(byId.get(qid).question, chunks[i].text));
    Object.assign(info, {
      name: reranker.name,
      totalSeconds: Math.round(totalSeconds * 10) / 10,
      medianQuestionMs: { 10: Math.round(median(perQuestion[10])), 20: Math.round(median(perQuestion[20])) },
      pairsTruncated: lengths.filter((n) => n > 512).length,
      longestPair: Math.max(...lengths),
    });
  } else {
    throw new Error(`Unknown reranker "${id}"; one of llm-judge, mxbai-q8, mxbai-fp32`);
  }
  scoreTables[id] = table;
  results.rerankers[id] = info;
  console.log(`${id}: ${JSON.stringify(info)}`);
}

// Order the candidates, then count what is found.
const order = (q, stage, n, reranker) => {
  const candidates = firstStage.get(q.id)[stage].slice(0, n);
  if (reranker === "first-stage") return candidates;
  const table = scoreTables[reranker];
  return rerankOrder(candidates, candidates.map((i) => table.get(`${q.id}\u0000${i}`)));
};
const foundWith = (q, ranked, budget) => found(q, (budget ? withinBudget(ranked, tokens, budget) : ranked).map((i) => chunks[i].text));
const groupCounts = (predicate) => GROUPS.map(([set, split]) => questions.filter((q) => q.set === set && q.split === split && predicate(q)).length);

let mismatches = 0;
const show = (ours, published) => {
  if (published === undefined) return `${String(ours).padStart(3)}`.padEnd(14);
  if (ours !== published) mismatches++;
  return `${String(ours).padStart(3)}${ours === published ? "" : ` ≠ ${published}`}`.padEnd(14);
};

console.log("\n1. Candidate recall: the evidence is in the first stage's top N (no budget)");
results.recall = {};
for (const stage of STAGES) {
  for (const n of COUNTS) {
    const key = `${stage} ${n}`;
    results.recall[key] = groupCounts((q) => foundWith(q, firstStage.get(q.id)[stage].slice(0, n)));
    console.log(`${key.padEnd(34)}${results.recall[key].map((v, k) => show(v, PUBLISHED.recall[key][k])).join("")}`);
  }
}

const rerankers = ["first-stage", ...Object.keys(scoreTables)];
const testQuestions = questions.filter((q) => q.split === "test");
console.log(`\n2. Evidence found within each budget, test questions (${testQuestions.length})`);
console.log(`${"first stage, candidates, order".padEnd(34)}${BUDGETS.map((b) => `${b} tokens`.padEnd(14)).join("")}`);
results.testByBudget = {};
for (const stage of STAGES) {
  for (const n of COUNTS) {
    for (const reranker of rerankers) {
      const key = `${stage} ${n} ${reranker}`;
      results.testByBudget[key] = BUDGETS.map((b) => testQuestions.filter((q) => foundWith(q, order(q, stage, n, reranker), b)).length);
      console.log(`${key.padEnd(34)}${results.testByBudget[key].map((v, k) => show(v, PUBLISHED.testByBudget[key]?.[k])).join("")}`);
    }
  }
}

console.log("\n3. Evidence found at 1000 tokens, by question group");
console.log(`${"first stage, candidates, order".padEnd(34)}${GROUPS.map(([s, p]) => `${s} ${p}`.padEnd(14)).join("")}`);
results.at1000 = {};
for (const stage of STAGES) {
  for (const n of COUNTS) {
    for (const reranker of rerankers) {
      const key = `${stage} ${n} ${reranker}`;
      results.at1000[key] = groupCounts((q) => foundWith(q, order(q, stage, n, reranker), 1000));
      console.log(`${key.padEnd(34)}${results.at1000[key].map((v, k) => show(v, PUBLISHED.at1000[key]?.[k])).join("")}`);
    }
  }
}

console.log(`\n${mismatches === 0 ? "Every published number matched." : `${mismatches} published numbers differ.`} (Rows with no published number are new.)`);
results.mismatches = mismatches;
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
}
store.close();
process.exit(mismatches === 0 ? 0 : 1);

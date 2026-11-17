// Latency per stage, through the same pipeline the app uses (default settings): the test
// questions (48 answerable, 10 the documents don't answer) and the 4 test follow-up
// conversations, one after another on a warm machine; then a cold start, with every model
// unloaded first.
//
//   npm run measure:latency [-- --battery]
//
// Timings depend on the machine and its power source, so the script refuses to run on
// battery unless --battery is given (the result records which it was). Needs the tokenizer,
// Ollama (nomic-embed-text, llama3.2:3b), and `npm run models`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { Answerer } from "../src/answer/answerer.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { loadQuestions } from "../src/evaluation/evidence.js";
import { openEvalCollection } from "../src/evaluation/setup.js";
import { createEmbeddings, createLLM } from "../src/providers/index.js";
import { createReranker } from "../src/rerank/index.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({
  options: {
    battery: { type: "boolean", default: false },
    out: { type: "string", default: "results/latency.json" },
  },
});
const power = execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).split("\n")[0];
if (/Battery Power/.test(power) && !args.battery) {
  console.error(`${power}. Timings on battery aren't comparable; plug in, or pass --battery to record them anyway.`);
  process.exit(1);
}
loadEnvFile();
const config = loadConfig({ LLM_SEED: "1", ...process.env });
const ollamaModels = [config.llm.provider === "ollama" && config.llm.model, config.embeddings.provider === "ollama" && config.embeddings.model].filter(Boolean);
const unload = () => ollamaModels.forEach((m) => execFileSync("ollama", ["stop", m], { stdio: "ignore" }));
const digest = (model) => {
  const line = execFileSync("ollama", ["list"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith(`${model} `) || l.startsWith(`${model}:latest `));
  return line?.split(/\s+/)[1] ?? null;
};
const setup = {
  date: new Date().toISOString(),
  power,
  // Other work on the machine slows every stage: the 1-minute load average, before and after.
  loadBefore: Math.round(loadavg()[0] * 10) / 10,
  cpu: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim(),
  node: process.version,
  ollama: execFileSync("ollama", ["--version"], { encoding: "utf8" }).trim().split("\n").pop().replace(/^.*version is /, ""),
  llm: config.llm.provider === "ollama" ? `${config.llm.model} (${digest(config.llm.model)})` : `${config.llm.provider}:${config.llm.model}`,
  embeddings: config.embeddings.provider === "ollama" ? `${config.embeddings.model} (${digest(config.embeddings.model)})` : `${config.embeddings.provider}:${config.embeddings.model}`,
  reranker: config.retrieval.reranker,
  retrieval: config.retrieval,
};
console.log(`${setup.cpu}, ${setup.power}, load ${setup.loadBefore}\n${setup.llm}, ${setup.embeddings}, ${setup.reranker}, ${config.retrieval.method} top ${config.retrieval.candidates}, ${config.retrieval.budget} tokens`);

const read = (file) => JSON.parse(readFileSync(new URL(`../eval/questions/${file}`, import.meta.url), "utf8"));
const answerable = Object.values(loadQuestions()).flat().filter((q) => q.split === "test");
const notInDocs = read("not-in-docs.json").questions.filter((q) => q.split === "test");
const followUps = read("follow-ups.json").conversations.filter((c) => c.split === "test");

const embeddings = createEmbeddings(config.embeddings);
const llm = createLLM(config.llm);
const { store, retriever } = await openEvalCollection({ tokenizer: loadTokenizer(), embeddings });

/** One question, timed from the caller's side as well as stage by stage. */
async function timed(answerer, question, history = []) {
  const started = performance.now();
  const result = await answerer.ask(question, { history });
  const t = result.timings;
  return {
    question,
    status: result.status,
    rewriteMs: history.length ? t.rewriteMs : null,
    embedMs: t.embedMs,
    searchMs: t.vectorMs + t.keywordMs,
    rerankMs: t.rerankMs ?? null,
    answerMs: t.answerMs ?? null,
    totalMs: performance.now() - started,
    outputTokens: result.usage?.outputTokens ?? null,
  };
}

// Cold start: every model unloaded, the reranker loaded from disk, then one question.
unload();
const started = performance.now();
const reranker = await createReranker(config.retrieval);
const rerankerLoadMs = performance.now() - started;
const answerer = new Answerer({ retriever, llm, reranker, retrieval: config.retrieval, gate: null, rewrite: config.answers.rewrite, citations: config.answers.citations });
const cold = await timed(answerer, answerable[0].question);
console.log(`Cold start: reranker loaded in ${Math.round(rerankerLoadMs)} ms; first question ${Math.round(cold.totalMs)} ms (embed ${Math.round(cold.embedMs)}, rerank ${Math.round(cold.rerankMs)}, answer ${Math.round(cold.answerMs)})`);

// Warm: every test question once, in order (the first again, now warm).
const warm = [];
for (const q of [...answerable, ...notInDocs]) warm.push({ kind: q.evidence ? "answerable" : "not-in-docs", ...(await timed(answerer, q.question)) });
for (const c of followUps) {
  const first = await answerer.ask(c.turns[0]);
  const history = [{ role: "user", content: c.turns[0] }, { role: "assistant", content: first.answer || "I couldn't find that in the documents." }];
  warm.push({ kind: "follow-up", ...(await timed(answerer, c.turns[1], history)) });
}
unload();
store.close();
setup.loadAfter = Math.round(loadavg()[0] * 10) / 10;

const quantile = (values, q) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const STAGES = [
  ["rewriteMs", "rewrite a follow-up (follow-ups only)"],
  ["embedMs", "embed the question"],
  ["searchMs", "score every chunk (vector and BM25)"],
  ["rerankMs", "rerank 10 candidates"],
  ["answerMs", "the model's answer"],
  ["totalMs", "total"],
];
const summary = {};
console.log(`\nWarm, ${warm.length} questions (median / 90th percentile / max, ms):`);
for (const [key, label] of STAGES) {
  const values = warm.map((r) => r[key]);
  const n = values.filter((v) => typeof v === "number").length;
  summary[key] = { n, median: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) };
  const s = summary[key];
  const fmt = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  console.log(`  ${label.padEnd(40)} ${fmt(s.median).padStart(6)} ${fmt(s.p90).padStart(6)} ${fmt(s.max).padStart(6)}   (n ${n})`);
}
const byKind = Object.fromEntries(["answerable", "not-in-docs", "follow-up"].map((kind) => [kind, quantile(warm.filter((r) => r.kind === kind).map((r) => r.totalMs), 0.5)]));
console.log(`  median total by kind: ${Object.entries(byKind).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")}`);

writeFileSync(args.out, `${JSON.stringify({ setup, cold: { rerankerLoadMs, ...cold }, summary, medianTotalByKind: byKind, warm }, null, 2)}\n`);
console.log(`Wrote ${args.out}`);

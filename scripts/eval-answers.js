// Answers through the whole pipeline, with the relevance gate off so its effect can be
// worked out afterwards from the same run. Choices are made on --split dev and reported on test.
//
//   npm run eval:answers -- --split dev --citations quotes
//
// For each answer: its status, its citations (valid or not), whether the evidence was in
// the excerpts, and whether the excerpts it cited contain the evidence. Correctness needs a
// reader: every reply is saved to --out.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Answerer } from "../src/answer/answerer.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { found, loadQuestions } from "../src/evaluation/evidence.js";
import { openEvalCollection } from "../src/evaluation/setup.js";
import { createEmbeddings, createLLM } from "../src/providers/index.js";
import { createReranker } from "../src/rerank/index.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({
  options: {
    split: { type: "string", default: "test" },
    citations: { type: "string", default: "numbers" },
    out: { type: "string" },
  },
});
args.out ??= `results/answers-${args.split}-${args.citations}.json`;
loadEnvFile();
const config = loadConfig({ LLM_SEED: "1", ...process.env });
const embeddings = createEmbeddings(config.embeddings);
const llm = createLLM(config.llm);
const reranker = await createReranker(config.retrieval);
const { store, retriever } = await openEvalCollection({ tokenizer: loadTokenizer(), embeddings });
const read = (file) => JSON.parse(readFileSync(new URL(`../eval/questions/${file}`, import.meta.url), "utf8"));
const answerable = Object.values(loadQuestions()).flat().filter((q) => q.split === args.split);
const notInDocs = read("not-in-docs.json").questions.filter((q) => q.split === args.split);
const followUps = read("follow-ups.json").conversations.filter((c) => c.split === args.split);
const gate = JSON.parse(readFileSync(new URL("../src/answer/gate.json", import.meta.url), "utf8")).thresholds;
let gateSignals = [];
try {
  gateSignals = JSON.parse(readFileSync(new URL("../results/gate-signals.json", import.meta.url), "utf8"));
} catch {
  console.log("(no results/gate-signals.json: run npm run tune:gate first to see the gate's effect)");
}

const setup = {
  date: new Date().toISOString(),
  power: execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).split("\n")[0],
  llm: llm.name,
  temperature: config.llm.temperature,
  seed: config.llm.seed,
  reranker: reranker?.name ?? "none",
  retrieval: config.retrieval,
  split: args.split,
  citations: args.citations,
};
console.log(`${args.split} questions, ${args.citations} citations; ${llm.name}, ${setup.reranker}, ${config.retrieval.method} top ${config.retrieval.candidates}, ${config.retrieval.budget} tokens; gate off; ${setup.power}`);
if (config.llm.provider === "ollama") execFileSync("ollama", ["stop", config.llm.model], { stdio: "ignore" });

const answerer = (rewrite = true) => new Answerer({ retriever, llm, reranker, retrieval: config.retrieval, gate: null, rewrite, citations: args.citations });
const record = (kind, q, result, evidence) => ({
  kind,
  id: q.id,
  question: q.question,
  status: result.status,
  declinedBy: result.declinedBy,
  answer: result.answer,
  searchQuestion: result.question,
  citations: result.citations.map((c) => c.label),
  invalidCitations: result.invalidCitations,
  retrieved: result.retrieved.map((c) => c.label),
  evidenceInContext: evidence ? found({ evidence }, result.retrieved.map((c) => c.text)) : null,
  evidenceCited: evidence ? found({ evidence }, result.citations.map((c) => c.text)) : null,
  answerMs: Math.round(result.timings.answerMs ?? 0),
  rewriteMs: Math.round(result.timings.rewriteMs ?? 0),
  usage: result.usage,
});

const records = [];
for (const q of answerable) records.push(record("answerable", q, await answerer().ask(q.question), q.evidence));
console.log(`answered ${answerable.length} answerable ${args.split} questions`);
for (const q of notInDocs) records.push(record("not-in-docs", q, await answerer().ask(q.question), null));
console.log(`answered ${notInDocs.length} not-in-docs ${args.split} questions`);
for (const c of followUps) {
  for (const rewrite of [true, false]) {
    const first = await answerer(rewrite).ask(c.turns[0]);
    const history = [{ role: "user", content: c.turns[0] }, { role: "assistant", content: first.answer || "I couldn't find that in the documents." }];
    const result = await answerer(rewrite).ask(c.turns[1], { history });
    records.push({ ...record(rewrite ? "follow-up, rewritten" : "follow-up, as asked", { id: c.id, question: c.turns[1] }, result, c.evidence), firstAnswer: first.answer });
  }
}
console.log(`answered ${followUps.length} follow-up conversations, with and without rewriting`);
if (config.llm.provider === "ollama") execFileSync("ollama", ["stop", config.llm.model], { stdio: "ignore" });

// Summary.
const of = (kind) => records.filter((r) => r.kind === kind);
const n = (list, predicate) => list.filter(predicate).length;
const A = of("answerable");
const U = of("not-in-docs");
console.log(`\nAnswerable ${args.split} questions (${A.length})`);
console.log(`  answered with valid citations ${n(A, (r) => r.status === "answered")}, answered without a valid citation ${n(A, (r) => r.status === "uncited")}, declined ${n(A, (r) => r.status === "not-found")}`);
console.log(`  evidence in the excerpts ${n(A, (r) => r.evidenceInContext)}; the cited excerpts contain the evidence ${n(A, (r) => r.evidenceCited)} of ${n(A, (r) => r.status !== "not-found")} answered`);
console.log(`  answers with an invalid citation (${args.citations === "quotes" ? "a quote found in no excerpt" : "a number of no excerpt"}): ${n(A, (r) => r.invalidCitations.length)}`);
console.log(`Not-in-docs ${args.split} questions (${U.length}): declined ${n(U, (r) => r.status === "not-found")}, answered ${n(U, (r) => r.status !== "not-found")}${n(U, (r) => r.status !== "not-found") ? ` (${U.filter((r) => r.status !== "not-found").map((r) => r.id).join(", ")})` : ""}`);
for (const kind of ["follow-up, rewritten", "follow-up, as asked"]) {
  const F = of(kind);
  console.log(`Follow-ups, ${kind.split(", ")[1]} (${F.length}): evidence in the excerpts ${n(F, (r) => r.evidenceInContext)}, answered ${n(F, (r) => r.status !== "not-found")}, cited evidence ${n(F, (r) => r.evidenceCited)}`);
}

// What each tuned gate would have changed, using its own signal for each question.
const signalById = new Map(gateSignals.map((s) => [s.id, s]));
const gateEffect = {};
for (const [key, { threshold }] of Object.entries(gate)) {
  const signal = key.split(":")[0];
  const blocked = (r) => signalById.has(r.id) && signalById.get(r.id)[signal] < threshold;
  gateEffect[key] = {
    threshold,
    notInDocsAnsweredThatItBlocks: U.filter((r) => r.status !== "not-found" && blocked(r)).map((r) => r.id),
    notInDocsItBlocks: U.filter(blocked).map((r) => r.id),
    answerableItBlocks: A.filter(blocked).map((r) => ({ id: r.id, status: r.status })),
  };
  const e = gateEffect[key];
  console.log(`Gate ${key} (< ${threshold}): would block ${e.notInDocsItBlocks.length} not-in-docs questions, ${e.notInDocsAnsweredThatItBlocks.length} of them ones the model answered; and ${e.answerableItBlocks.length} answerable (${e.answerableItBlocks.map((x) => `${x.id}: ${x.status}`).join(", ") || "none"})`);
}

const answerMs = A.map((r) => r.answerMs).sort((a, b) => a - b);
console.log(`Answer call: median ${answerMs[Math.floor(answerMs.length / 2)]} ms (${setup.power})`);
writeFileSync(args.out, `${JSON.stringify({ setup, gateEffect, records }, null, 2)}\n`);
console.log(`Wrote every reply to ${args.out}`);
store.close();

import assert from "node:assert/strict";
import { test } from "node:test";
import { Answerer, PROMPTS, checkCitations, matchQuotes } from "../src/answer/answerer.js";

const CHUNKS = [
  { label: "billing#3", document: "billing-guide.md", text: "| Monthly price | $10 | $25 |", tokens: 12, start: 0, end: 28, rerankScore: 2.1, vectorScore: 0.71 },
  { label: "billing#4", document: "billing-guide.md", text: "| Annual price | $100 | $250 |", tokens: 12, start: 29, end: 58, rerankScore: 1.4, vectorScore: 0.69 },
];

/** A retriever that returns fixed chunks and remembers the questions it was asked. */
function fakeRetriever(chunks = CHUNKS) {
  return {
    questions: [],
    async search(question) {
      this.questions.push(question);
      return { chunks, tokens: 24, best: { vector: 0.71, rerank: 2.1 }, timings: { embedMs: 1, rerankMs: 2 } };
    },
  };
}

/** A model whose replies are scripted: one for rewrites, one for answers. */
function fakeLLM({ answer, rewrite = { question: "How much does the Pro plan cost per year?" } }) {
  return {
    name: "fake",
    calls: [],
    async complete(messages, { schema }) {
      this.calls.push({ messages, schema });
      const reply = schema === PROMPTS.rewrite.schema ? rewrite : typeof answer === "function" ? answer(schema) : answer;
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), stopReason: "stop", usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

const retrieval = { method: "vector", budget: 1000, candidates: 10 };

test("an answer with valid citations returns the cited excerpts", async () => {
  const llm = fakeLLM({ answer: { answered: true, answer: "Pro costs $25 a month.", citations: [1] } });
  const result = await new Answerer({ retriever: fakeRetriever(), llm, retrieval, reranker: { name: "r" } }).ask("How much is Pro per month?");
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Pro costs $25 a month.");
  assert.deepEqual(result.citations.map((c) => [c.number, c.label]), [[1, "billing#3"]]);
  assert.deepEqual(result.invalidCitations, []);
  assert.equal(result.promptVersion, "docs-cited-v1");
  // The excerpts are numbered in the prompt; the question is the user's message.
  const [system, user] = llm.calls[0].messages;
  assert.match(system.content, /\[1\] billing-guide\.md\n\| Monthly price/);
  assert.match(system.content, /\[2\] billing-guide\.md\n\| Annual price/);
  assert.deepEqual(user, { role: "user", content: "How much is Pro per month?" });
  assert.equal(llm.calls.length, 1, "no rewrite without history");
});

test("citations outside the excerpts are reported; an answer with none valid is flagged uncited", async () => {
  const some = await new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer: { answered: true, answer: "x", citations: [2, 7, 2, 0] } }), retrieval }).ask("q");
  assert.equal(some.status, "answered");
  assert.deepEqual(some.citations.map((c) => c.number), [2]);
  assert.deepEqual(some.invalidCitations, [7, 0]);

  const none = await new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer: { answered: true, answer: "x", citations: [] } }), retrieval }).ask("q");
  assert.equal(none.status, "uncited");
});

test("the model can decline", async () => {
  const result = await new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer: { answered: false, answer: "", citations: [] } }), retrieval }).ask("Is there a dark mode?");
  assert.equal(result.status, "not-found");
  assert.equal(result.declinedBy, "model");
});

test("the gate declines without asking the model when the best score is below the threshold", async () => {
  const llm = fakeLLM({ answer: { answered: true, answer: "should not happen", citations: [1] } });
  const answerer = new Answerer({ retriever: fakeRetriever(), llm, retrieval, reranker: { name: "r" }, gate: { signal: "rerank", threshold: 3 } });
  const result = await answerer.ask("Is there a dark mode?");
  assert.equal(result.status, "not-found");
  assert.equal(result.declinedBy, "gate");
  assert.deepEqual(result.best, { vector: 0.71, rerank: 2.1 });
  assert.equal(llm.calls.length, 0);

  assert.equal((await new Answerer({ retriever: fakeRetriever(), llm, retrieval, gate: { signal: "rerank", threshold: 2 } }).ask("q")).status, "answered");
  assert.equal((await new Answerer({ retriever: fakeRetriever(), llm, retrieval, gate: { signal: "vector", threshold: 0.8 } }).ask("q")).declinedBy, "gate");
  // A gate on the reranker's signal, with no reranker run, declines rather than passing everything.
  const noRerank = { async search() { return { chunks: CHUNKS, best: { vector: 0.9, rerank: null }, timings: {} }; } };
  assert.equal((await new Answerer({ retriever: noRerank, llm, retrieval, gate: { signal: "rerank", threshold: 0 } }).ask("q")).declinedBy, "gate");
});

test("a follow-up is rewritten before retrieval, and the conversation goes to the answer prompt", async () => {
  const retriever = fakeRetriever();
  const llm = fakeLLM({ answer: { answered: true, answer: "$250 a year.", citations: [2] } });
  const history = [
    { role: "user", content: "How much does the Pro plan cost per month?" },
    { role: "assistant", content: "Pro costs $25 a month." },
  ];
  const result = await new Answerer({ retriever, llm, retrieval }).ask("And per year?", { history });
  assert.equal(result.question, "How much does the Pro plan cost per year?");
  assert.deepEqual(retriever.questions, ["How much does the Pro plan cost per year?"]);
  assert.match(llm.calls[0].messages[1].content, /User: How much does the Pro plan cost per month\?\nAssistant: Pro costs \$25 a month\.\n\nLatest message: And per year\?/);
  const answerMessages = llm.calls[1].messages;
  assert.deepEqual(answerMessages.slice(1), [...history, { role: "user", content: "And per year?" }]);

  // With rewriting off, retrieval gets the follow-up as it is.
  const plain = fakeRetriever();
  await new Answerer({ retriever: plain, llm: fakeLLM({ answer: { answered: false, answer: "", citations: [] } }), retrieval, rewrite: false }).ask("And per year?", { history });
  assert.deepEqual(plain.questions, ["And per year?"]);
});

test("a reply that is not the expected JSON is an error that says so", async () => {
  await assert.rejects(new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer: "Sure! Pro is $25." }), retrieval }).ask("q"), /not the expected JSON: Sure! Pro is \$25\./);
});

test("checkCitations keeps in-range integers once, in order", () => {
  assert.deepEqual(checkCitations([3, 1, 3, 4, 1.5, "2"], 3), { valid: [3, 1], invalid: [4, 1.5, "2"] });
  assert.deepEqual(checkCitations(undefined, 3), { valid: [], invalid: [] });
});

test("quote citations: each quote is found in an excerpt, so the citation is checked by construction", async () => {
  const answer = (schema) => {
    assert.ok(schema.properties.quotes, "the quoted prompt's schema");
    return { answered: true, answer: "Pro is $250 a year.", quotes: ["| Annual price | $100 | $250 |", "Pro is cheap", "Yes"] };
  };
  const result = await new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer }), retrieval, citations: "quotes" }).ask("How much is Pro per year?");
  assert.equal(result.status, "answered");
  assert.equal(result.promptVersion, "docs-quoted-v1");
  assert.deepEqual(result.citations.map((c) => [c.number, c.label, c.quote]), [[2, "billing#4", "| Annual price | $100 | $250 |"]]);
  assert.deepEqual(result.invalidCitations, ["Pro is cheap", "Yes"], "not in any excerpt; too short to count");

  const none = await new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({ answer: { answered: true, answer: "x", quotes: ["made up words here"] } }), retrieval, citations: "quotes" }).ask("q");
  assert.equal(none.status, "uncited");
  assert.throws(() => new Answerer({ retriever: fakeRetriever(), llm: fakeLLM({}), retrieval, citations: "footnotes" }), /Unknown citation style/);
});

test("matchQuotes ignores case, spacing, and surrounding quotation marks; cites each excerpt once", () => {
  const excerpts = [{ number: 1, text: "Suspended members keep their role,\nproject memberships, and tasks." }, { number: 2, text: "Invoices are emailed monthly." }];
  assert.deepEqual(matchQuotes(['"suspended MEMBERS keep their role, project memberships"', "and tasks.", "invoices are emailed monthly"], excerpts), {
    citations: [{ number: 1, quote: '"suspended MEMBERS keep their role, project memberships" … and tasks.' }, { number: 2, quote: "invoices are emailed monthly" }],
    unmatched: [],
  });
  assert.deepEqual(matchQuotes([42, "nowhere to be found"], excerpts).unmatched, [42, "nowhere to be found"]);
  assert.deepEqual(matchQuotes(undefined, excerpts), { citations: [], unmatched: [] });
});

test("the gate threshold comes from the tuned file, only for the models it was tuned with", async () => {
  const { gateFor } = await import("../src/answer/index.js");
  assert.equal(gateFor("off", {}), null);
  const vector = gateFor("vector", { embeddings: { name: "ollama:nomic-embed-text" } });
  assert.equal(vector.signal, "vector");
  assert.ok(vector.threshold > 0.5 && vector.threshold < 0.7);
  assert.throws(() => gateFor("vector", { embeddings: { name: "openai-compatible:text-embedding-3-small" } }), /no threshold has been tuned for openai-compatible:text-embedding-3-small/);
  assert.throws(() => gateFor("rerank", { embeddings: { name: "x" } }), /needs a reranker/);
});

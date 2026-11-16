import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { ingest } from "../src/ingest.js";
import { rerankOrder } from "../src/retrieval/rank.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { JUDGE_SETTINGS, judgeMessages, judgeScore, llmJudgeReranker } from "../src/rerank/llm-judge.js";
import { MODELS_DIR, RERANKERS } from "../src/rerank/models.js";
import { Store } from "../src/store/store.js";
import { EstimatedTokens } from "../src/text/tokens.js";

test("the judge's score is log P(yes labels) − log P(no labels)", () => {
  const top = { Yes: -0.5, yes: -3, No: -1.2, Maybe: -6 };
  const expected = Math.log(Math.exp(-0.5) + Math.exp(-3)) - -1.2;
  assert.ok(Math.abs(judgeScore(top) - expected) < 1e-12);
  // A label with no variant among the alternatives gets the lowest listed log-probability.
  assert.ok(Math.abs(judgeScore({ Yes: -0.1, Other: -9 }) - (-0.1 - -9)) < 1e-12);
});

test("candidates are reordered by score; ties keep their first-stage order", () => {
  assert.deepEqual(rerankOrder([7, 3, 5, 9], [0.1, 0.9, 0.1, 0.5]), [3, 9, 7, 5]);
});

describe("the LLM judge against a mock Ollama", () => {
  let server;
  let baseUrl;
  const requests = [];
  before(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      // Relevant when the passage (not the question) has the answer.
      const relevant = request.messages[1].content.includes("Entity ID");
      res.end(JSON.stringify({
        message: { role: "assistant", content: relevant ? "Yes" : "No" },
        logprobs: [{ token: relevant ? "Yes" : "No", top_logprobs: [{ token: "Yes", logprob: relevant ? -0.1 : -4 }, { token: "No", logprob: relevant ? -3 : -0.05 }] }],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test("sends one request per passage with the demo's prompt and settings", async () => {
    const judge = llmJudgeReranker({ baseUrl });
    const scores = await judge.score("What does SSO-104 mean?", ["SSO-104: the Entity ID doesn't match.", "Invoices go out monthly."]);
    assert.ok(scores[0] > 0 && scores[1] < 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, judgeMessages("What does SSO-104 mean?", "SSO-104: the Entity ID doesn't match."));
    assert.equal(requests[0].model, "llama3.2:3b");
    assert.deepEqual(requests[0].options, JUDGE_SETTINGS.options);
    assert.equal(requests[0].logprobs, true);
    assert.equal(requests[0].top_logprobs, 20);
    assert.equal(requests[0].stream, false);
  });
});

/** Scores a passage by how many of the question's words it contains. */
const wordReranker = {
  name: "fake:words",
  calls: [],
  async score(question, passages) {
    this.calls.push(passages.length);
    const words = question.toLowerCase().match(/[a-z0-9]+/g);
    return passages.map((p) => words.filter((w) => p.toLowerCase().includes(w)).length);
  },
};

/** Every chunk gets the same vector, so the first stage keeps chunk order. */
const flatEmbeddings = { name: "fake:flat", embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) };

test("search with a reranker: only the top candidates, reordered, then the budget", async () => {
  const store = new Store(":memory:");
  const sections = ["Alpha notes.", "Beta notes.", "Gamma notes.", "Invoices are emailed monthly to the billing contact."];
  ingest(store, "docs", [{ name: "doc.md", text: sections.map((s, i) => `## Part ${i + 1}\n\n${s}`).join("\n\n") }], new EstimatedTokens());
  const retriever = new Retriever({ store, collection: "docs", embeddings: flatEmbeddings });
  await retriever.prepare();

  const plain = await retriever.search("When are invoices emailed?", { method: "vector", budget: 1000 });
  assert.deepEqual(plain.chunks.map((c) => c.label), ["doc#1", "doc#2", "doc#3", "doc#4"], "ties keep chunk order");

  const reranked = await retriever.search("When are invoices emailed?", { method: "vector", budget: 1000, rerank: { reranker: wordReranker, candidates: 4 } });
  assert.equal(reranked.chunks[0].label, "doc#4");
  assert.equal(reranked.chunks[0].rerankScore, 3);
  assert.ok(reranked.timings.rerankMs >= 0);

  const narrow = await retriever.search("When are invoices emailed?", { method: "vector", budget: 1000, rerank: { reranker: wordReranker, candidates: 2 } });
  assert.deepEqual(narrow.chunks.map((c) => c.label), ["doc#1", "doc#2"], "a chunk outside the candidates is never used");
  assert.deepEqual(wordReranker.calls, [4, 2]);
  store.close();
});

const mxbai = RERANKERS["mxbai-rerank-xsmall-v1"];
const downloaded = existsSync(`${MODELS_DIR}${mxbai.repository}/${mxbai.precisions.fp32.file}`);

test("the cross-encoder ranks the answering passage first (real model)", { skip: downloaded ? false : "model not downloaded (npm run models)" }, async () => {
  const { crossEncoderReranker } = await import("../src/rerank/cross-encoder.js");
  const reranker = await crossEncoderReranker();
  const question = "What does SSO-104 mean?";
  const passages = ["Invoices are emailed on the first of each month.", "| SSO-104 | The Entity ID doesn't match | Copy the Entity ID again. |"];
  const scores = await reranker.score(question, passages);
  assert.ok(scores[1] > scores[0], `${scores}`);
  assert.equal(reranker.name, "cross-encoder:mxbai-rerank-xsmall-v1:fp32");
  assert.ok(reranker.countTokens(question, passages[1]) < 60);
  // At full precision a pair's score does not depend on what it is batched with
  // (with the quantised file it moved by up to 0.08).
  const [alone] = await reranker.score(question, [passages[1]]);
  const [, padded] = await reranker.score(question, [`${passages[0]} ${"More text. ".repeat(20)}`, passages[1]]);
  assert.ok(Math.abs(alone - scores[1]) < 1e-5 && Math.abs(alone - padded) < 1e-5, `${alone} / ${scores[1]} / ${padded}`);
});

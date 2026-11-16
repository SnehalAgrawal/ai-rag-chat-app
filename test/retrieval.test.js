import assert from "node:assert/strict";
import { test } from "node:test";
import { found } from "../src/evaluation/evidence.js";
import { ingest } from "../src/ingest.js";
import { BM25, analyze } from "../src/retrieval/keyword.js";
import { cosine, minMax, rank, rrf, weighted, withinBudget } from "../src/retrieval/rank.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { Store } from "../src/store/store.js";
import { EstimatedTokens } from "../src/text/tokens.js";

test("analyzers: words split identifiers, identifiers also keep them whole", () => {
  assert.deepEqual(analyze("What does SSO-104 mean?"), ["what", "does", "sso", "104", "mean"]);
  assert.deepEqual(analyze("cursor_expired at X-RateLimit", "identifiers"), ["cursor", "expired", "at", "x", "ratelimit", "cursor_expired", "x-ratelimit"]);
  assert.throws(() => analyze("x", "stems"), /unknown analyzer/);
});

test("BM25 matches Lucene's formula on a hand-computed example", () => {
  const index = new BM25(["apple banana", "apple apple cherry", "durian"]);
  const [a, b, c] = index.scores("apple");
  // df(apple) = 2 of N = 3: idf = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln(1.6)
  const idf = Math.log(1.6);
  const avg = (2 + 3 + 1) / 3;
  const score = (tf, length) => (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * length) / avg));
  assert.ok(Math.abs(a - score(1, 2)) < 1e-12);
  assert.ok(Math.abs(b - score(2, 3)) < 1e-12);
  assert.equal(c, 0);
  assert.deepEqual(rank(index.scores("apple"), true), [1, 0], "only chunks sharing a word, best first");
});

test("rank breaks ties by position; RRF and weighted fusion follow their definitions", () => {
  assert.deepEqual(rank([0.5, 0.9, 0.5]), [1, 0, 2]);
  // Two rankings of three items, k = 60.
  const fused = rrf([[0, 1, 2], [2, 0]], 60, 3);
  assert.deepEqual(fused, [1 / 61 + 1 / 62, 1 / 62, 1 / 63 + 1 / 61]);
  assert.deepEqual(minMax([2, 4, 6]), [0, 0.5, 1]);
  assert.deepEqual(minMax([3, 3]), [0, 0]);
  const mixed = weighted([0, 1], [1, 0], 0.8);
  assert.ok(Math.abs(mixed[0] - 0.2) < 1e-12 && Math.abs(mixed[1] - 0.8) < 1e-12, "floating-point sums");
  assert.ok(Math.abs(cosine([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-12);
});

test("the budget skips a chunk that does not fit and keeps going", () => {
  assert.deepEqual(withinBudget([0, 1, 2, 3], [400, 700, 300, 400], 1000), [0, 2]);
  assert.deepEqual(withinBudget([0], [1200], 1000), []);
});

test("a question is found when every passage of one accepted answer is inside the retrieved text", () => {
  const question = { evidence: [[{ text: "SSO-104" }, { text: "Entity ID" }], [{ text: "contact support" }]] };
  assert.equal(found(question, ["| SSO-104 | The Entity ID doesn't match |"]), true);
  assert.equal(found(question, ["SSO-104 only"]), false);
  assert.equal(found(question, ["SSO-104", "the Entity ID"]), true, "passages may be in different chunks");
  assert.equal(found(question, ["please contact support"]), true, "or the other accepted answer");
});

/** A deterministic embedding: letter frequencies. Counts calls and texts embedded. */
function letterEmbeddings(name = "fake:letters") {
  return {
    name,
    texts: 0,
    async embed(texts) {
      this.texts += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(26);
        for (const ch of t.toLowerCase()) if (ch >= "a" && ch <= "z") v[ch.charCodeAt(0) - 97] += 1;
        return v;
      });
    },
  };
}

const DOCUMENTS = [
  { name: "sso.md", text: "# Single sign-on\n\n## Errors\n\nSSO-104 means the Entity ID does not match.\n\n## Setup\n\nOpen Settings, then Security.\n" },
  { name: "billing.md", text: "# Billing\n\n## Invoices\n\nInvoices are emailed on the first of the month.\n" },
];

test("the retriever embeds only what is missing, and re-embeds everything when the model changes", async () => {
  const store = new Store(":memory:");
  ingest(store, "docs", DOCUMENTS, new EstimatedTokens());
  const first = letterEmbeddings();
  assert.deepEqual(await new Retriever({ store, collection: "docs", embeddings: first }).prepare(), { chunks: 3, embedded: 3 });
  assert.deepEqual(await new Retriever({ store, collection: "docs", embeddings: first }).prepare(), { chunks: 3, embedded: 0 });
  const other = letterEmbeddings("fake:other-model");
  assert.deepEqual(await new Retriever({ store, collection: "docs", embeddings: other }).prepare(), { chunks: 3, embedded: 3 });
  assert.ok(store.chunks("docs").every((c) => c.embeddingModel === "fake:other-model"));
  store.close();
});

test("search returns ranked chunks within the budget, with scores and timings", async () => {
  const store = new Store(":memory:");
  ingest(store, "docs", DOCUMENTS, new EstimatedTokens());
  const retriever = new Retriever({ store, collection: "docs", embeddings: letterEmbeddings() });
  await assert.rejects(retriever.scores("x"), /prepare\(\) has not been run/);
  await retriever.prepare();

  const keyword = await retriever.search("What does SSO-104 mean?", { method: "keyword", budget: 1000 });
  assert.equal(keyword.chunks[0].label, "sso#1");
  assert.ok(keyword.chunks.every((c) => c.keywordScore > 0), "keyword search returns only matching chunks");
  assert.equal(keyword.chunks[0].embedding, undefined, "vectors are not returned");

  const hybrid = await retriever.search("When are invoices emailed?", { method: "rrf", budget: 1000 });
  assert.equal(hybrid.chunks.length, 3, "RRF ranks every chunk");
  assert.equal(hybrid.chunks[0].label, "billing#1");
  assert.deepEqual(hybrid.chunks.map((c) => c.rank), [1, 2, 3]);
  assert.ok(hybrid.timings.embedMs >= 0 && hybrid.timings.keywordMs >= 0);

  const small = await retriever.search("When are invoices emailed?", { method: "rrf", budget: hybrid.chunks[0].tokens });
  assert.deepEqual(small.chunks.map((c) => c.label), ["billing#1"]);
  assert.equal(small.tokens, hybrid.chunks[0].tokens);

  await assert.rejects(retriever.search("x", { method: "semantic" }), /Unknown retrieval method "semantic"/);
  store.close();
});

test("collections are searched separately", async () => {
  const store = new Store(":memory:");
  ingest(store, "a", [DOCUMENTS[0]], new EstimatedTokens());
  ingest(store, "b", [DOCUMENTS[1]], new EstimatedTokens());
  const retriever = new Retriever({ store, collection: "b", embeddings: letterEmbeddings() });
  await retriever.prepare();
  const { chunks } = await retriever.search("SSO-104", { method: "vector" });
  assert.ok(chunks.every((c) => c.document === "billing.md"));
  store.close();
});

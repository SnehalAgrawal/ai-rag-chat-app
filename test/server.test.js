// The HTTP API with fake models (no downloads, no network).

import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store/store.js";
import { EstimatedTokens } from "../src/text/tokens.js";

const letters = {
  name: "fake:letters",
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(26);
      for (const ch of t.toLowerCase()) if (ch >= "a" && ch <= "z") v[ch.charCodeAt(0) - 97] += 1;
      return v;
    });
  },
};
const llm = {
  name: "fake:llm",
  async complete(messages) {
    const asksAboutInvoices = messages.at(-1).content.toLowerCase().includes("invoice");
    return { text: JSON.stringify(asksAboutInvoices ? { answered: true, answer: "On the first of each month.", citations: [1] } : { answered: false, answer: "", citations: [] }) };
  },
};

let server;
let base;
before(async () => {
  const config = loadConfig({ RERANKER: "none" });
  const app = new App({ config, store: new Store(":memory:"), embeddings: letters, llm, reranker: null, tokenizer: new EstimatedTokens() });
  server = await startServer(app, { port: 0, maxUploadBytes: 2000, log: () => {} });
  base = server.url;
});
after(() => server.close());

/** A raw request, so unusual paths reach the server as written. */
function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, type: res.headers["content-type"], text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
const put = (path, text) => call("PUT", path, Buffer.from(text));
const postJson = (path, body) => call("POST", path, JSON.stringify(body), { "content-type": "application/json" });
const GUIDE = "# Billing\n\n## Invoices\n\nInvoices are emailed on the first of each month.\n\n## Refunds\n\nRefunds are possible within 30 days.\n";

test("status names the models and settings in use", async () => {
  const { status, json } = await call("GET", "/api/status");
  assert.equal(status, 200);
  assert.equal(json.llm, "fake:llm");
  assert.equal(json.reranker, null);
  assert.equal(json.retrieval.method, "rrf");
  assert.deepEqual(json.supported, [".md", ".markdown", ".txt", ".pdf"]);
});

test("collections: created with valid names only", async () => {
  assert.equal((await postJson("/api/collections", { name: "handbook" })).status, 200);
  for (const name of ["Handbook", "-x", "a/b", "", "x".repeat(41)]) {
    const { status, json } = await postJson("/api/collections", { name });
    assert.equal(status, 400, name);
    assert.match(json.error, /lowercase letters, digits, or hyphens/);
  }
  assert.ok((await call("GET", "/api/collections")).json.some((c) => c.name === "handbook"));
});

test("documents: upload, re-upload, update, read, and errors", async () => {
  assert.deepEqual((await put("/api/collections/handbook/documents/billing.md", GUIDE)).json, { name: "billing.md", outcome: "added", chunks: 2, embedded: 2 });
  assert.equal((await put("/api/collections/handbook/documents/billing.md", GUIDE)).json.outcome, "unchanged");
  assert.equal((await put("/api/collections/handbook/documents/billing.md", `${GUIDE}\nMore.\n`)).json.outcome, "updated");
  const listed = (await call("GET", "/api/collections/handbook/documents")).json;
  assert.deepEqual(listed.map((d) => [d.name, d.chunks]), [["billing.md", 2]]);
  assert.match((await call("GET", "/api/collections/handbook/documents/billing.md")).json.text, /^# Billing/);

  assert.equal((await put("/api/collections/handbook/documents/tool.exe", "x")).status, 415);
  assert.equal((await put("/api/collections/handbook/documents/big.md", "x".repeat(3000))).status, 413);
  const invalid = await call("PUT", "/api/collections/handbook/documents/bad.txt", Buffer.from([0xff, 0xfe, 0xfd]));
  assert.equal(invalid.status, 422);
  assert.match(invalid.json.error, /not readable as UTF-8/);
  assert.equal((await put("/api/collections/handbook/documents/..%2Fescape.md", "x")).status, 400);
  assert.equal((await put("/api/collections/Bad%20Name/documents/a.md", "x")).status, 400);
  assert.equal((await call("GET", "/api/collections/handbook/documents/missing.md")).status, 404);
});

/** Reads an ask response's newline-delimited JSON events. */
async function ask(collection, question, history = []) {
  const { status, type, text } = await postJson(`/api/collections/${collection}/ask`, { question, history });
  return { status, type, events: text.trim().split("\n").map((line) => JSON.parse(line)) };
}

test("ask streams its stages, then the answer with its citations", async () => {
  const { status, type, events } = await ask("handbook", "When are invoices sent?");
  assert.equal(status, 200);
  assert.match(type, /application\/x-ndjson/);
  assert.deepEqual(events.map((e) => e.stage ?? e.type), ["retrieving", "retrieved", "answering", "answer"]);
  const answer = events.at(-1);
  assert.equal(answer.status, "answered");
  assert.equal(answer.answer, "On the first of each month.");
  assert.equal(answer.citations[0].document, "billing.md");
  assert.match(answer.citations[0].text, /Invoices are emailed/);
  assert.ok(events[1].retrieved.length > 0);

  const declined = (await ask("handbook", "Is there a dark mode?")).events.at(-1);
  assert.deepEqual([declined.status, declined.declinedBy], ["not-found", "model"]);
});

test("ask: an empty collection, an empty question, and bad JSON are explained", async () => {
  await postJson("/api/collections", { name: "empty" });
  assert.match((await ask("empty", "Anything?")).events.at(-1).error, /has no documents yet/);
  assert.match((await ask("handbook", "   ")).events.at(-1).error, /Ask a question/);
  const bad = await call("POST", "/api/collections/handbook/ask", "{not json");
  assert.deepEqual([bad.status, bad.json.error], [400, "The request body must be JSON."]);
});

test("delete removes a document", async () => {
  await put("/api/collections/handbook/documents/notes.txt", "Some notes.");
  assert.deepEqual((await call("DELETE", "/api/collections/handbook/documents/notes.txt")).json, { name: "notes.txt", deleted: true });
  assert.equal((await call("DELETE", "/api/collections/handbook/documents/notes.txt")).status, 404);
});

test("the page is served, and nothing outside public/", async () => {
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/api/nope"]) assert.equal((await call("GET", path)).status, 404, path);
});

// The embedding providers against a local mock server speaking each API's format.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { ollamaEmbeddings, prefixesFor } from "../src/providers/embeddings/ollama.js";
import { openAICompatibleEmbeddings } from "../src/providers/embeddings/openai-compatible.js";

let server;
let baseUrl;
let requests = [];
let respond;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    respond(JSON.parse(body), res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A fake embedding: [input length, index in batch]. */
const fake = (texts) => texts.map((t, i) => [t.length, i]);

test("ollama: adds nomic-embed-text's task prefixes, never truncates, and batches", async () => {
  requests = [];
  respond = (body, res) => res.end(JSON.stringify({ embeddings: fake(body.input) }));
  const embeddings = ollamaEmbeddings({ baseUrl, model: "nomic-embed-text", batchSize: 2 });
  const vectors = await embeddings.embed(["a", "bb", "ccc"]);
  assert.equal(embeddings.name, "ollama:nomic-embed-text");
  assert.deepEqual(vectors.map((v) => [...v]), [[18, 0], [19, 1], [20, 0]], "prefix (17 characters) + text");
  assert.ok(vectors.every((v) => v instanceof Float32Array));
  assert.equal(requests.length, 2, "two batches");
  assert.deepEqual(requests[0].body, { model: "nomic-embed-text", input: ["search_document: a", "search_document: bb"], truncate: false, keep_alive: "10m" });

  requests = [];
  await embeddings.embed(["where?"], { kind: "query" });
  assert.deepEqual(requests[0].body.input, ["search_query: where?"]);
});

test("ollama: prefixes apply to tagged names, and other models get none", () => {
  assert.deepEqual(prefixesFor("nomic-embed-text:latest"), { document: "search_document: ", query: "search_query: " });
  assert.deepEqual(prefixesFor("mxbai-embed-large"), { document: "", query: "" });
});

test("ollama: an input over the model's context is an error, not a silently cut vector", async () => {
  respond = (body, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "the input length exceeds the context length" }));
  };
  await assert.rejects(ollamaEmbeddings({ baseUrl }).embed(["x"]), /400 .*exceeds the context length/);
});

test("ollama: a wrong number of vectors is an error", async () => {
  respond = (body, res) => res.end(JSON.stringify({ embeddings: [[1]] }));
  await assert.rejects(ollamaEmbeddings({ baseUrl }).embed(["a", "b"]), /expected 2 vectors, got 1/);
});

test("openai-compatible: sends the key, keeps input order by index, and ignores the query/document kind", async () => {
  requests = [];
  respond = (body, res) =>
    res.end(JSON.stringify({ data: fake(body.input).map((embedding, index) => ({ index, embedding })).reverse(), model: body.model }));
  const embeddings = openAICompatibleEmbeddings({ baseUrl: `${baseUrl}/v1`, apiKey: "sk-test" });
  const vectors = await embeddings.embed(["one", "three"], { kind: "query" });
  assert.equal(embeddings.name, "openai-compatible:text-embedding-3-small");
  assert.deepEqual(vectors.map((v) => [...v]), [[3, 0], [5, 1]], "in input order, though the response was reversed");
  assert.equal(requests[0].url, "/v1/embeddings");
  assert.equal(requests[0].headers.authorization, "Bearer sk-test");
  assert.deepEqual(requests[0].body, { model: "text-embedding-3-small", input: ["one", "three"] });
});

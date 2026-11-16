import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingest, readDocument } from "../src/ingest.js";
import { Store } from "../src/store/store.js";
import { EstimatedTokens } from "../src/text/tokens.js";

const tokenizer = new EstimatedTokens();
const GUIDE = "# Guide\n\n## Setup\n\nInstall it.\n\n## Use\n\nRun it.\n";

test("ingest adds new documents, skips unchanged ones, and replaces changed ones", () => {
  const store = new Store(":memory:");
  assert.deepEqual(ingest(store, "docs", [{ name: "guide.md", text: GUIDE }], tokenizer), { added: ["guide.md"], updated: [], unchanged: [], empty: [] });
  assert.deepEqual(ingest(store, "docs", [{ name: "guide.md", text: GUIDE }], tokenizer).unchanged, ["guide.md"]);
  const before = store.chunks("docs").map((c) => c.id);

  const changed = GUIDE.replace("Run it.", "Run it with care.");
  assert.deepEqual(ingest(store, "docs", [{ name: "guide.md", text: changed }], tokenizer).updated, ["guide.md"]);
  const chunks = store.chunks("docs");
  assert.deepEqual(chunks.map((c) => c.label), ["guide#1", "guide#2"]);
  assert.equal(chunks[1].text, "# Guide\n\n## Use\n\nRun it with care.");
  assert.ok(chunks.every((c) => !before.includes(c.id)), "old chunks were replaced");
  assert.equal(store.documents("docs").length, 1);
  store.close();
});

test("collections are separate, and empty documents are reported, not stored", () => {
  const store = new Store(":memory:");
  ingest(store, "a", [{ name: "guide.md", text: GUIDE }], tokenizer);
  const result = ingest(store, "b", [{ name: "guide.md", text: GUIDE }, { name: "blank.md", text: "  \n" }], tokenizer);
  assert.deepEqual(result.added, ["guide.md"]);
  assert.deepEqual(result.empty, ["blank.md"]);
  assert.deepEqual(store.collections().map((c) => [c.name, c.documents, c.chunks]), [["a", 1, 2], ["b", 1, 2]]);
  assert.ok(store.deleteDocument("a", "guide.md"));
  assert.equal(store.chunks("a").length, 0, "chunks go with their document");
  assert.equal(store.chunks("b").length, 2);
  assert.equal(store.deleteDocument("a", "guide.md"), false);
  store.close();
});

test("embeddings are stored per chunk with the model that made them", () => {
  const store = new Store(":memory:");
  ingest(store, "docs", [{ name: "guide.md", text: GUIDE }], tokenizer);
  const [first, second] = store.chunks("docs");
  assert.equal(first.embedding, null);
  store.setEmbeddings("nomic-embed-text", [{ id: first.id, vector: [0.25, -1, 3.5] }]);
  const [stored, untouched] = store.chunks("docs");
  assert.ok(stored.embedding instanceof Float32Array);
  assert.deepEqual([...stored.embedding], [0.25, -1, 3.5]);
  assert.equal(stored.embeddingModel, "nomic-embed-text");
  assert.equal(untouched.id, second.id);
  assert.equal(untouched.embedding, null);
  store.close();
});

test("a failure while storing a document leaves nothing half-written", () => {
  const store = new Store(":memory:");
  assert.throws(() =>
    store.putDocument("docs", "bad.md", "text", () => {
      throw new Error("chunker failed");
    }),
  );
  assert.equal(store.documents("docs").length, 0);
  store.close();
});

test("the database persists to a file, and readDocument normalises line endings and checks the type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rag-store-"));
  try {
    const path = join(dir, "data", "app.db");
    await writeFile(join(dir, "windows.md"), "# Title\r\n\r\nLine one.\r\nLine two.\r\n");
    await writeFile(join(dir, "image.png"), "not text");
    const document = await readDocument(join(dir, "windows.md"));
    assert.equal(document.text, "# Title\n\nLine one.\nLine two.\n");
    await assert.rejects(readDocument(join(dir, "image.png")), /unsupported file type \.png/);

    const store = new Store(path);
    ingest(store, "docs", [document], tokenizer);
    store.close();
    const reopened = new Store(path);
    assert.equal(reopened.chunks("docs").length, 1);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

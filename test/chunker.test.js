import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { chunkDocument, headingStack, parseLines } from "../src/text/chunker.js";
import { DEFAULT_TOKENIZER_PATH, EstimatedTokens, loadTokenizer } from "../src/text/tokens.js";

const documentsDir = new URL("../eval/documents/", import.meta.url);
const documents = readdirSync(documentsDir).filter((f) => f.endsWith(".md")).sort();
const read = (name) => readFileSync(new URL(name, documentsDir), "utf8");
const exact = existsSync(process.env.TOKENIZER_PATH || DEFAULT_TOKENIZER_PATH);

test(
  "the port makes exactly the chunks rag-engineering's chunker makes (98 chunks, 10,913 tokens)",
  { skip: exact ? false : "needs the Llama 3.2 tokenizer at models/tokenizer.json (see the README)" },
  () => {
    const fixture = JSON.parse(readFileSync(new URL("fixtures/structure-chunks.json", import.meta.url), "utf8"));
    const tokenizer = loadTokenizer();
    const { kind, max_tokens: maxTokens, headings } = fixture.strategy;
    const ours = documents.flatMap((name) => chunkDocument(name, read(name), { kind, maxTokens, headings }, tokenizer));
    assert.deepEqual(
      ours.map(({ id, document, start, end, tokens }) => ({ id, document, start, end, tokens })),
      fixture.chunks,
    );
    assert.equal(ours.length, 98);
    assert.equal(ours.reduce((n, c) => n + c.tokens, 0), 10913);
  },
);

test("every chunk is a slice of its document, with the headings above it in front", () => {
  const tokenizer = new EstimatedTokens();
  for (const name of documents) {
    const text = read(name);
    for (const chunk of chunkDocument(name, text, { maxTokens: 512 }, tokenizer)) {
      assert.equal(chunk.text, chunk.prefix + text.slice(chunk.start, chunk.end), chunk.id);
      assert.ok(chunk.tokens <= 512 + tokenizer.count(chunk.prefix), `${chunk.id} within budget`);
      const above = headingStack(parseLines(text), chunk.start).filter((h) => h.start < chunk.start);
      for (const heading of above) assert.ok(chunk.prefix.includes(heading.text), `${chunk.id} keeps "${heading.text}"`);
    }
  }
});

test("a small document is one chunk; a heading with nothing under it joins the next section", () => {
  const tokenizer = new EstimatedTokens();
  const text = "# Guide\n\n## Setup\n\nInstall it.\n\n## Use\n\nRun it.\n";
  const chunks = chunkDocument("guide.md", text, { maxTokens: 512 }, tokenizer);
  assert.deepEqual(chunks.map((c) => c.text), ["# Guide\n\n## Setup\n\nInstall it.", "# Guide\n\n## Use\n\nRun it."]);
  assert.deepEqual(chunks.map((c) => c.id), ["guide#1", "guide#2"]);
});

test("a long section is split by blocks, and a code block is never split mid-way when it fits", () => {
  const tokenizer = new EstimatedTokens();
  const paragraph = (n) => `Paragraph ${n} ${"word ".repeat(30)}`.trim();
  const code = "```\nconst a = 1;\nconst b = 2;\n```";
  const text = `# Title\n\n${paragraph(1)}\n\n${code}\n\n${paragraph(2)}\n\n${paragraph(3)}\n`;
  const chunks = chunkDocument("long.md", text, { maxTokens: 60 }, tokenizer);
  assert.ok(chunks.length > 1, "split");
  assert.ok(chunks.some((c) => c.text.includes(code)), "the code block stays whole");
  assert.ok(chunks.slice(1).every((c) => c.prefix === "# Title\n\n"), "later chunks carry the heading");
});

test("text without headings is chunked as one section", () => {
  const tokenizer = new EstimatedTokens();
  const chunks = chunkDocument("notes.txt", "Just some plain notes.\nSecond line.", { maxTokens: 512 }, tokenizer);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "notes#1");
  assert.equal(chunks[0].prefix, "");
});

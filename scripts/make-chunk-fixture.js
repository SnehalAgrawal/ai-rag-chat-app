// Writes test/fixtures/structure-chunks.json: the structure-headings chunks of the eval
// documents, made by rag-engineering's own chunker (05-hybrid-search/javascript), so the
// test can check this app's port produces exactly the same chunks.
//
//   node scripts/make-chunk-fixture.js /path/to/rag-engineering

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? "../rag-engineering");
const demo = join(root, "05-hybrid-search");
process.env.TOKENIZER_PATH ??= join(demo, "data", "tokenizer.json");
const { chunk } = await import(pathToFileURL(join(demo, "javascript", "chunkers.js")));
const { Tokenizer } = await import(pathToFileURL(join(demo, "javascript", "tokens.js")));
const settings = JSON.parse(readFileSync(join(demo, "data", "settings.json"), "utf8"));

const documentsDir = new URL("../eval/documents/", import.meta.url);
const documents = Object.fromEntries(
  readdirSync(documentsDir).filter((f) => f.endsWith(".md")).sort().map((f) => [f, readFileSync(new URL(f, documentsDir), "utf8")]),
);
const chunks = await chunk(settings.chunking, documents, new Tokenizer());
const fixture = {
  _comment: "Made by scripts/make-chunk-fixture.js from rag-engineering's 05-hybrid-search chunker; do not edit by hand.",
  strategy: settings.chunking,
  chunks: chunks.map(({ id, document, start, end, tokens }) => ({ id, document, start, end, tokens })),
};
writeFileSync(new URL("../test/fixtures/structure-chunks.json", import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`${chunks.length} chunks from ${Object.keys(documents).length} documents (${chunks.reduce((n, c) => n + c.tokens, 0)} tokens)`);

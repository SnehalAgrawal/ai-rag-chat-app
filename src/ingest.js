// Turns files into stored, chunked documents. Markdown and plain text for now; PDF comes
// in a later step.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { chunkDocument } from "./text/chunker.js";

export const SUPPORTED = [".md", ".markdown", ".txt"];

/** The default chunking: rag-engineering's winning strategy (structure, 512 tokens, headings copied in). */
export const DEFAULT_STRATEGY = { kind: "structure", maxTokens: 512, headings: true };

/** Reads a file's text, with Windows line endings normalised (chunk offsets index this text). */
export async function readDocument(path) {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED.includes(extension)) {
    throw new Error(`${basename(path)}: unsupported file type ${extension || "(none)"}; supported: ${SUPPORTED.join(", ")}`);
  }
  const text = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  return { name: basename(path), text };
}

/**
 * Stores documents in a collection: new ones are chunked and added, changed ones replaced,
 * unchanged ones left alone.
 * @param {import("./store/store.js").Store} store
 * @param {string} collection
 * @param {{ name: string, text: string }[]} documents
 * @param {{ count(text: string): number }} tokenizer
 */
export function ingest(store, collection, documents, tokenizer, strategy = DEFAULT_STRATEGY) {
  const results = { added: [], updated: [], unchanged: [], empty: [] };
  for (const { name, text } of documents) {
    if (!text.trim()) {
      results.empty.push(name);
      continue;
    }
    const outcome = store.putDocument(collection, name, text, (t) => chunkDocument(name, t, strategy, tokenizer));
    results[outcome].push(name);
  }
  return results;
}

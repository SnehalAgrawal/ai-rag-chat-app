// Turns files into stored, chunked documents: Markdown, plain text, and PDF (its text
// extracted, with headings rebuilt from font sizes: src/text/pdf.js).

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { chunkDocument } from "./text/chunker.js";
import { extractPdf } from "./text/pdf.js";

export const SUPPORTED = [".md", ".markdown", ".txt", ".pdf"];

/** The default chunking: rag-engineering's winning strategy (structure, 512 tokens, headings copied in). */
export const DEFAULT_STRATEGY = { kind: "structure", maxTokens: 512, headings: true };

/** Reads a file's text, with Windows line endings normalised (chunk offsets index this text). */
export async function readDocument(path) {
  return documentFromBytes(basename(path), new Uint8Array(await readFile(path)));
}

/** A document from a file's name and bytes (an upload, or a file read from disk). */
export async function documentFromBytes(name, bytes) {
  const extension = extname(name).toLowerCase();
  if (!SUPPORTED.includes(extension)) {
    throw new Error(`${name}: unsupported file type ${extension || "(none)"}; supported: ${SUPPORTED.join(", ")}`);
  }
  if (extension === ".pdf") {
    const { text, pages } = await extractPdf(bytes);
    if (!text.trim()) throw new Error(`${name}: no text found in ${pages} page(s); a scanned PDF needs OCR first`);
    return { name, text };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name}: not readable as UTF-8 text`);
  }
  return { name, text: text.replace(/\r\n?/g, "\n") };
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

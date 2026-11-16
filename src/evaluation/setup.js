// The evaluation collection: rag-engineering's five documents, chunked with the exact
// tokenizer and embedded, in their own database, ready for the measurement scripts.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ingest } from "../ingest.js";
import { Retriever } from "../retrieval/retriever.js";
import { Store } from "../store/store.js";

const DOCUMENTS = new URL("../../eval/documents/", import.meta.url);

export async function openEvalCollection({ dbPath = "data/eval.db", tokenizer, embeddings }) {
  if (!tokenizer.exact) {
    throw new Error("The measurements need the Llama 3.2 tokenizer at models/tokenizer.json (see the README): with estimated token counts the chunks differ, so the numbers are not comparable.");
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath);
  const documents = readdirSync(DOCUMENTS).filter((f) => f.endsWith(".md")).sort().map((name) => ({ name, text: readFileSync(new URL(name, DOCUMENTS), "utf8") }));
  ingest(store, "eval", documents, tokenizer);
  const retriever = new Retriever({ store, collection: "eval", embeddings });
  const prepared = await retriever.prepare();
  return { store, retriever, embedded: prepared.embedded };
}

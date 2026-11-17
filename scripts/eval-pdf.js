// Does a PDF lose the evidence? The same five documents as Markdown and as PDF
// (eval/pdf, made by scripts/make-eval-pdfs.js), compared three ways:
//   1. extraction: is each evidence passage still in the document's extracted text?
//   2. structure: how many headings were recovered?
//   3. retrieval: evidence found for the questions, with the default pipeline and with RRF.
// Text is compared normalised (no Markdown symbols, spacing, or case) on both sides, so a
// table row from the PDF matches its Markdown source.
//
//   npm run eval:pdf

import { readFileSync, readdirSync } from "node:fs";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { foundNormalised, loadQuestions, normaliseForMatching } from "../src/evaluation/evidence.js";
import { ingest, readDocument } from "../src/ingest.js";
import { createEmbeddings } from "../src/providers/index.js";
import { createReranker } from "../src/rerank/index.js";
import { withinBudget } from "../src/retrieval/rank.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { Store } from "../src/store/store.js";
import { parseLines } from "../src/text/chunker.js";
import { loadTokenizer } from "../src/text/tokens.js";

loadEnvFile();
const config = loadConfig();
const tokenizer = loadTokenizer();
if (!tokenizer.exact) {
  console.error("Needs the Llama 3.2 tokenizer at models/tokenizer.json (see the README).");
  process.exit(1);
}
const MD = new URL("../eval/documents/", import.meta.url);
const PDF = new URL("../eval/pdf/", import.meta.url);
const names = readdirSync(MD).filter((f) => f.endsWith(".md")).sort();
const markdown = names.map((name) => ({ name, text: readFileSync(new URL(name, MD), "utf8") }));
const pdf = await Promise.all(names.map((name) => readDocument(new URL(name.replace(/\.md$/, ".pdf"), PDF).pathname)));
const questions = Object.values(loadQuestions()).flat();

// 1. Extraction: every evidence passage, looked up in its own document.
console.log("1. Evidence passages still present in the document's text (normalised)");
const passages = questions.flatMap((q) => q.evidence.flat().map((p) => ({ id: q.id, ...p })));
const unique = [...new Map(passages.map((p) => [`${p.document}\u0000${p.text}`, p])).values()];
const text = (docs, name) => normaliseForMatching(docs.find((d) => d.name.replace(/\.pdf$/, ".md") === name).text);
const missing = { markdown: [], pdf: [] };
for (const p of unique) {
  if (!text(markdown, p.document).includes(normaliseForMatching(p.text))) missing.markdown.push(p);
  if (!text(pdf, p.document).includes(normaliseForMatching(p.text))) missing.pdf.push(p);
}
console.log(`   Markdown ${unique.length - missing.markdown.length} of ${unique.length}; PDF ${unique.length - missing.pdf.length} of ${unique.length}`);
for (const p of missing.pdf) console.log(`   missing from the PDF text (${p.id}, ${p.document}): ${JSON.stringify(p.text)}`);

// 2. Structure.
const headings = (t) => parseLines(t).filter((l) => l.kind === "heading").length;
console.log("\n2. Headings: Markdown → recovered from the PDF");
for (const [i, name] of names.entries()) console.log(`   ${name.padEnd(28)} ${headings(markdown[i].text)} → ${headings(pdf[i].text)}`);

// 3. Retrieval, on the same pipeline for both.
const store = new Store(":memory:");
ingest(store, "markdown", markdown, tokenizer);
ingest(store, "pdf", pdf, tokenizer);
const embeddings = createEmbeddings(config.embeddings);
const reranker = await createReranker(config.retrieval);
const retrievers = {};
for (const collection of ["markdown", "pdf"]) {
  retrievers[collection] = new Retriever({ store, collection, embeddings });
  const { chunks } = await retrievers[collection].prepare();
  const tokens = retrievers[collection].chunks.reduce((n, c) => n + c.tokens, 0);
  console.log(`${collection === "markdown" ? "\n3. Retrieval\n" : ""}   ${collection}: ${chunks} chunks, ${tokens} tokens`);
}
const BUDGETS = [500, 1000, 2000];
const test = questions.filter((q) => q.split === "test");
const pipelines = {
  [`vector top ${config.retrieval.candidates} → ${reranker?.name ?? "no reranker"}`]: { method: "vector", rerank: reranker ? { reranker, candidates: config.retrieval.candidates } : null },
  "rrf, no reranking": { method: "rrf", rerank: null },
};
console.log(`   Evidence found for the ${test.length} test questions (normalised matching), by budget`);
console.log(`   ${"pipeline".padEnd(72)}${BUDGETS.map((b) => `${b}`.padEnd(10)).join("")}`);
for (const [label, { method, rerank }] of Object.entries(pipelines)) {
  for (const collection of ["markdown", "pdf"]) {
    const retriever = retrievers[collection];
    const counts = BUDGETS.map(() => 0);
    for (const q of test) {
      // The full ranked order (no budget), then each budget applied to it, as in the published method.
      const { chunks } = await retriever.search(q.question, { method, budget: Infinity, rerank });
      const ranked = chunks.map((c) => retriever.chunks.findIndex((x) => x.id === c.id));
      BUDGETS.forEach((budget, i) => {
        const chosen = withinBudget(ranked, retriever.chunks.map((c) => c.tokens), budget);
        if (foundNormalised(q, chosen.map((k) => retriever.chunks[k].text))) counts[i]++;
      });
    }
    console.log(`   ${`${label}, ${collection}`.padEnd(72)}${counts.map((n) => `${n}`.padEnd(10)).join("")}`);
  }
}
store.close();

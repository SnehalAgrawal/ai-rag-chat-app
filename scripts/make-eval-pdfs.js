// Makes PDF versions of the evaluation documents (eval/documents/*.md → eval/pdf/*.pdf):
// Markdown rendered to HTML with plain print styling, printed to A4 by Google Chrome.
// The PDFs are committed, so the measurements don't need Chrome; this script records how
// they were made.
//
//   node scripts/make-eval-pdfs.js        (needs Google Chrome installed)
//
// These are clean, digitally made PDFs: one column, real text, headings in larger type.
// Scanned pages, multi-column layouts, and text drawn as images are harder, and are not
// covered by these files.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { marked } from "marked";
import { chromium } from "playwright-core";

const SOURCE = new URL("../eval/documents/", import.meta.url);
const TARGET = new URL("../eval/pdf/", import.meta.url);
const STYLE = `
  body { font: 11pt/1.45 "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 12pt; }
  h2 { font-size: 16pt; margin: 18pt 0 8pt; }
  h3 { font-size: 13pt; margin: 14pt 0 6pt; }
  p, li { margin: 0 0 6pt; }
  table { border-collapse: collapse; margin: 6pt 0 10pt; }
  th, td { border: 0.5pt solid #999; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  code { font: 10pt Menlo, monospace; }
  pre { background: #f4f4f4; padding: 6pt; white-space: pre-wrap; }
`;

mkdirSync(TARGET, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  for (const name of readdirSync(SOURCE).filter((f) => f.endsWith(".md")).sort()) {
    const markdown = readFileSync(new URL(name, SOURCE), "utf8");
    const title = (markdown.match(/^# (.+)$/m)?.[1] ?? name).replace(/[<&]/g, "");
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${marked.parse(markdown)}</body></html>`);
    const path = new URL(name.replace(/\.md$/, ".pdf"), TARGET).pathname;
    await page.pdf({ path, format: "A4", margin: { top: "18mm", bottom: "18mm", left: "18mm", right: "18mm" }, printBackground: true });
    console.log(`eval/pdf/${name.replace(/\.md$/, ".pdf")}`);
  }
} finally {
  await browser.close();
}

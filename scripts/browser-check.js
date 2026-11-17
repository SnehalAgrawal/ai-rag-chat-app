// The web app end to end in headless Google Chrome, with the real models: create a
// collection, upload the evaluation documents (one as PDF), ask a question and a follow-up,
// open a citation, and ask something the documents don't cover.
//
//   npm run check:browser [-- --screenshots results/screens]
//
// Needs Google Chrome, Ollama (nomic-embed-text, llama3.2:3b), and `npm run models`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { App } from "../src/app.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { createEmbeddings, createLLM } from "../src/providers/index.js";
import { createReranker } from "../src/rerank/index.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store/store.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({ options: { screenshots: { type: "string" } } });
loadEnvFile();
const config = loadConfig();
const dir = mkdtempSync(join(tmpdir(), "rag-browser-"));
const app = new App({
  config,
  store: new Store(join(dir, "app.db")),
  embeddings: createEmbeddings(config.embeddings),
  llm: createLLM(config.llm),
  reranker: await createReranker(config.retrieval),
  tokenizer: loadTokenizer(),
});
const server = await startServer(app, { port: 0, log: () => {} });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const files = ["admin-guide.md", "api-reference.md", "billing-guide.md", "release-notes.md"].map((f) => new URL(`../eval/documents/${f}`, import.meta.url).pathname);
files.push(new URL("../eval/pdf/data-processing-policy.pdf", import.meta.url).pathname);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.url);

  // A new collection, then the documents through the file input.
  await page.fill("#new-collection-name", "handbook");
  await page.click("#new-collection-form button[type=submit]");
  await page.waitForSelector("#collection option[value=handbook]", { state: "attached" });
  // An unsupported file among them: its error must still be shown once the others are in.
  const unsupported = join(dir, "notes.docx");
  writeFileSync(unsupported, "not a supported format");
  await page.setInputFiles("#files", [files[0], unsupported, ...files.slice(1)]);
  await page.waitForFunction(() => globalThis.document.querySelectorAll("#documents li .name").length === 5, null, { timeout: 120_000 });
  await page.waitForFunction(() => !globalThis.document.querySelector("#upload-status").textContent.includes("Adding"), null, { timeout: 120_000 });
  check("five documents uploaded, one of them a PDF", true, (await page.$$eval("#documents .name", (n) => n.map((x) => x.textContent))).join(", "));
  const uploadStatus = await page.$eval("#upload-status", (n) => n.textContent);
  check("an unsupported file's error stays visible after the other uploads", /notes\.docx: /.test(uploadStatus) && (uploadStatus.match(/: added/g) ?? []).length === 5, JSON.stringify(uploadStatus));

  const askAndWait = async (question) => {
    const before = await page.$$eval(".turn-assistant", (n) => n.length);
    await page.fill("#question", question);
    await page.press("#question", "Enter");
    await page.waitForFunction((n) => {
      const turns = globalThis.document.querySelectorAll(".turn-assistant");
      return turns.length > n && !turns[turns.length - 1].querySelector(".stage");
    }, before, { timeout: 120_000 });
    return page.$eval(".turn-assistant:last-child", (n) => ({
      answer: n.querySelector(".answer")?.textContent ?? null,
      notice: n.querySelector(".notice")?.textContent ?? null,
      warning: n.querySelector(".warning")?.textContent ?? null,
      citations: [...n.querySelectorAll(".citations .cite")].map((c) => c.textContent),
      searched: n.querySelector("details.why em")?.textContent ?? null,
    }));
  };

  const first = await askAndWait("How much does the Pro plan cost per month?");
  check("an answer with a citation", Boolean(first.answer) && first.citations.length > 0, `${JSON.stringify(first.answer)} ${first.citations.join(", ")}`);
  check("it states the price ($25)", /\$25\b/.test(first.answer ?? ""));

  const follow = await askAndWait("And per year?");
  check(
    "the follow-up is answered from the conversation",
    /\$250/.test(follow.answer ?? ""),
    `searched for ${follow.searched ? JSON.stringify(follow.searched) : "the question as asked (not rewritten)"}; answered ${JSON.stringify(follow.answer)}`,
  );
  const formHidden = await page.$eval("#new-collection-form", (f) => globalThis.getComputedStyle(f).display === "none");
  check("the new-collection form is hidden after creating one", formHidden);

  // Open each of the first answer's citations: each opens its passage, highlighted in its
  // document. (Whether a cited passage holds the answer is the citation accuracy measured
  // in step 4; here it is reported, not required.)
  const opened = [];
  const cites = await page.$$(".turn-assistant:nth-of-type(2) .citations .cite");
  for (const [i, cite] of cites.entries()) {
    await cite.click();
    await page.waitForSelector("#viewer[open] mark");
    opened.push(await page.$eval("#viewer", (d) => ({ title: d.querySelector("#viewer-title").textContent, mark: d.querySelector("mark").textContent })));
    if (args.screenshots && i === cites.length - 1) {
      mkdirSync(args.screenshots, { recursive: true });
      await page.screenshot({ path: join(args.screenshots, "viewer.png") });
    }
    await page.click("#viewer-close");
  }
  check(
    "each citation opens its passage, highlighted in its document",
    opened.length === cites.length && opened.every((v) => v.mark.length > 0),
    opened.map((v) => `${v.title}: ${JSON.stringify(v.mark.slice(0, 50))}…`).join(" | "),
  );
  console.log(`     the price ($25) is in ${opened.filter((v) => /\$25\b/.test(v.mark)).length} of the ${opened.length} cited passages`);

  const unknown = await askAndWait("Is there a dark mode?");
  check("a question the documents don't answer is declined", Boolean(unknown.notice) && !unknown.answer, JSON.stringify(unknown.notice ?? unknown.answer));

  await page.click(".turn-assistant:last-child details.why summary");
  if (args.screenshots) {
    await page.screenshot({ path: join(args.screenshots, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(args.screenshots, "phone.png"), fullPage: true });
  }
  check("no errors in the page", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
const failed = checks.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);

// A screen recording of the web app with the real models, made by driving it in Google
// Chrome: create a collection, upload the five evaluation documents (one a PDF), ask a
// question, open each of its citations, ask a follow-up, then ask something the documents
// don't cover and open "Why this answer". Nothing is edited or sped up: every wait is the
// app's own; the typing and the pauses to read are the script's.
//
//   npm run record:demo [-- --out results/demo.webm]
//
// Playwright records WebM (VP8). Needs Google Chrome, Ollama (nomic-embed-text,
// llama3.2:3b), and `npm run models`.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { App } from "../src/app.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { createEmbeddings, createLLM } from "../src/providers/index.js";
import { createReranker } from "../src/rerank/index.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store/store.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args } = parseArgs({ options: { out: { type: "string", default: "results/demo.webm" } } });
loadEnvFile();
const config = loadConfig();
const dir = mkdtempSync(join(tmpdir(), "rag-demo-"));
const embeddings = createEmbeddings(config.embeddings);
const llm = createLLM(config.llm);
const app = new App({ config, store: new Store(join(dir, "app.db")), embeddings, llm, reranker: await createReranker(config.retrieval), tokenizer: loadTokenizer() });
const server = await startServer(app, { port: 0, log: () => {} });
const files = ["admin-guide.md", "api-reference.md", "billing-guide.md", "release-notes.md"].map((f) => new URL(`../eval/documents/${f}`, import.meta.url).pathname);
files.push(new URL("../eval/pdf/data-processing-policy.pdf", import.meta.url).pathname);

// Load the models before recording, so the video doesn't show a cold start.
await embeddings.embed(["warm up"], { kind: "query" });
await llm.complete([{ role: "user", content: "Say OK." }]);
const size = { width: 1280, height: 800 };
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: size, colorScheme: "light", recordVideo: { dir, size } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
const type = async (selector, text) => {
  await page.click(selector);
  await page.type(selector, text, { delay: 45 });
};
const askAndWait = async (question) => {
  const before = await page.$$eval(".turn-assistant", (n) => n.length);
  await type("#question", question);
  await pause(400);
  await page.press("#question", "Enter");
  await page.waitForFunction((n) => {
    const turns = globalThis.document.querySelectorAll(".turn-assistant");
    return turns.length > n && !turns[turns.length - 1].querySelector(".stage");
  }, before, { timeout: 120_000 });
};

try {
  await page.goto(server.url);
  await pause(1500);
  await type("#new-collection-name", "handbook");
  await pause(300);
  await page.click("#new-collection-form button[type=submit]");
  await page.waitForSelector("#collection option[value=handbook]", { state: "attached" });
  await pause(800);
  await page.setInputFiles("#files", files);
  await page.waitForFunction(() => globalThis.document.querySelectorAll("#documents li .name").length === 5, null, { timeout: 120_000 });
  await pause(1500);

  await askAndWait("How much does the Pro plan cost per month?");
  await pause(2500);
  // Every citation, not a chosen one: whether each holds the answer is part of what's shown.
  const cites = await page.$$(".turn-assistant:last-child .citations .cite");
  for (const cite of cites) {
    await cite.click();
    await page.waitForSelector("#viewer[open] mark");
    await pause(3000);
    await page.click("#viewer-close");
    await pause(600);
  }

  await askAndWait("And per year?");
  await pause(3000);

  await askAndWait("Is there a dark mode?");
  await pause(1500);
  await page.click(".turn-assistant:last-child details.why summary");
  await pause(1500);
  // To the end of the page: the whole panel, down to the stage timings, above the composer.
  await page.evaluate(() => globalThis.scrollTo({ top: globalThis.document.body.scrollHeight, behavior: "smooth" }));
  await pause(5000);
} finally {
  const video = page.video();
  await context.close();
  if (video) {
    mkdirSync(dirname(args.out), { recursive: true });
    await video.saveAs(args.out);
    console.log(`Wrote ${args.out}`);
  }
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

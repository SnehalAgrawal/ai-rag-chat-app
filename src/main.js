// npm start: the web app at http://127.0.0.1:3000 (PORT, HOST to change).

import { App } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { createEmbeddings, createLLM } from "./providers/index.js";
import { createReranker } from "./rerank/index.js";
import { startServer } from "./server.js";
import { Store } from "./store/store.js";
import { loadTokenizer } from "./text/tokens.js";

loadEnvFile();
const config = loadConfig();
let reranker;
try {
  reranker = await createReranker(config.retrieval);
} catch (error) {
  console.error(`${error.message}\n(Or run without a reranker: RERANKER=none npm start)`);
  process.exit(1);
}
const tokenizer = loadTokenizer();
const app = new App({
  config,
  store: new Store(config.databasePath),
  embeddings: createEmbeddings(config.embeddings),
  llm: createLLM(config.llm),
  reranker,
  tokenizer,
});
const server = await startServer(app, { port: config.port, host: config.host, maxUploadBytes: config.maxUploadMB * 1024 * 1024 });
const status = app.status();
console.log(`Answers: ${status.llm} | embeddings: ${status.embeddings} | reranker: ${status.reranker ?? "none"}${tokenizer.exact ? "" : " | token counts estimated"}`);
console.log(`Open ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}

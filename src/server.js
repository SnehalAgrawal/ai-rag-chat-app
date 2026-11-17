// The HTTP server: the web page from public/, and a small JSON API over the App.
//
//   GET    /api/status
//   GET    /api/collections                      POST /api/collections {name}
//   GET    /api/collections/:c/documents
//   GET    /api/collections/:c/documents/:file   the document's text
//   PUT    /api/collections/:c/documents/:file   upload: the file's bytes as the body
//   DELETE /api/collections/:c/documents/:file
//   POST   /api/collections/:c/ask {question, history}
//          → newline-delimited JSON: {"type":"stage",...} events, then {"type":"answer",...}
//            or {"type":"error",...}. Closing the connection stops the work.
//
// Listens on 127.0.0.1 by default: there are no accounts, so anyone who can reach the server
// can read and change its documents.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./app.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const JSON_LIMIT = 64 * 1024;

export async function startServer(app, { port = 3000, host = "127.0.0.1", maxUploadBytes = 20 * 1024 * 1024, log = console.log } = {}) {
  const routes = [
    ["GET", /^\/api\/status$/, () => app.status()],
    ["GET", /^\/api\/collections$/, () => app.collections()],
    ["POST", /^\/api\/collections$/, async (req) => app.createCollection((await readJson(req)).name)],
    ["GET", /^\/api\/collections\/([^/]+)\/documents$/, (req, [c]) => app.documents(c)],
    ["GET", /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/, (req, [c, d]) => app.document(c, d)],
    ["PUT", /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/, async (req, [c, d]) => app.addDocument(c, d, await readBody(req, maxUploadBytes))],
    ["DELETE", /^\/api\/collections\/([^/]+)\/documents\/([^/]+)$/, (req, [c, d]) => app.deleteDocument(c, d)],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      const ask = url.pathname.match(/^\/api\/collections\/([^/]+)\/ask$/);
      if (ask && req.method === "POST") return await handleAsk(app, decodeURIComponent(ask[1]), req, res, log);
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (!match) continue;
        if (req.method !== method) continue;
        const params = match.slice(1).map(decodeURIComponent);
        return sendJson(res, 200, await handler(req, params));
      }
      if (url.pathname.startsWith("/api/")) throw new UserError("Not found.", 404);
      return await serveStatic(url.pathname, req, res);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof UserError) return sendJson(res, error.status, { error: error.message });
      log(`error: ${req.method} ${url.pathname}: ${error.stack ?? error.message}`);
      return sendJson(res, 500, { error: "Something went wrong on the server; see its log." });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function handleAsk(app, collection, req, res, log) {
  const { question, history } = await readJson(req);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("the client disconnected"));
  });
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  const send = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const answer = await app.ask(collection, question, { history, signal: controller.signal, onStage: (event) => send({ type: "stage", ...event }) });
    send({ type: "answer", ...answer });
  } catch (error) {
    if (controller.signal.aborted) return res.end();
    if (!(error instanceof UserError)) log(`error: ask in ${collection}: ${error.stack ?? error.message}`);
    send({ type: "error", error: error instanceof UserError ? error.message : `The answer failed: ${error.message}` });
  }
  res.end();
}

async function serveStatic(pathname, req, res) {
  const file = normalize(join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  const type = TYPES[extname(file)];
  if (req.method !== "GET" || !file.startsWith(PUBLIC) || !type) throw new UserError("Not found.", 404);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    throw new UserError("Not found.", 404);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) throw new UserError(`The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`, 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError(`The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`, 413);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req) {
  const body = await readBody(req, JSON_LIMIT);
  try {
    return JSON.parse(new TextDecoder().decode(body) || "{}");
  } catch {
    throw new UserError("The request body must be JSON.");
  }
}

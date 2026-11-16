// Downloads reranker models into models/, at a pinned revision, checking every file's SHA-256.
//
//   npm run models                                    the default reranker (mxbai-rerank-xsmall-v1, fp32, 284 MB)
//   npm run models -- mxbai-rerank-xsmall-v1 q8       the quantised file (87 MB; see the README)

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODELS_DIR, RERANKERS } from "../src/rerank/models.js";

const [name = "mxbai-rerank-xsmall-v1", precision = "fp32"] = process.argv.slice(2);
const model = RERANKERS[name];
if (!model?.precisions[precision]) {
  console.error(`Unknown model or precision: ${name} ${precision}. Known: ${Object.entries(RERANKERS).map(([n, m]) => `${n} (${Object.keys(m.precisions).join(", ")})`).join("; ")}`);
  process.exit(1);
}

const files = { ...model.files, [model.precisions[precision].file]: model.precisions[precision].sha256 };
const dir = `${MODELS_DIR}${model.repository}/`;
for (const [file, sha256] of Object.entries(files)) {
  const target = dir + file;
  if (existsSync(target) && hash(readFileSync(target)) === sha256) {
    console.log(`${file}: present, sha256 verified`);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
  const digest = createHash("sha256");
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => digest.update(chunk));
  await pipeline(body, createWriteStream(`${target}.partial`));
  const actual = digest.digest("hex");
  if (actual !== sha256) {
    await rm(`${target}.partial`);
    throw new Error(`${file}: checksum mismatch (expected ${sha256}, got ${actual}); file removed`);
  }
  await rename(`${target}.partial`, target);
  console.log(`${file}: downloaded, sha256 verified`);
}
console.log(`${name} (${precision}) is ready in ${dir} (licence: ${model.licence}).`);

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

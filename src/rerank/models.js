// Downloadable reranker models: exact revisions, file checksums, and licences. Files come
// from Hugging Face at the pinned revision and are checked before use (scripts/download-models.js).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODELS_DIR = fileURLToPath(new URL("../../models/", import.meta.url));

export const RERANKERS = {
  "mxbai-rerank-xsmall-v1": {
    repository: "mixedbread-ai/mxbai-rerank-xsmall-v1",
    revision: "b5c6e9da73abc3711f593f705371cdbe9e0fe422",
    licence: "Apache-2.0",
    // Shared by both precisions.
    files: {
      "config.json": "470a53befc79da411cc04e466770d9f219f3c14adb276bfa0a58df28774ceade",
      "tokenizer.json": "305674b4d785287feecfb5f73f24aa75e9b57c87c579cfe24fbd207987d4b4c4",
      "tokenizer_config.json": "aafc9f36a056307bf0cbfcbd42fe00d9df89083d23db6114466c8bfaedb09ce5",
      "special_tokens_map.json": "b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21",
      "added_tokens.json": "dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f",
    },
    precisions: {
      // transformers.js dtype → ONNX file (sizes in MB)
      q8: { file: "onnx/model_quantized.onnx", sha256: "15ef19a6de90be7d52b627f2c784107bd806e64826450f41fb75fa4f0179ab30", sizeMB: 87 },
      fp32: { file: "onnx/model.onnx", sha256: "536b7183f8964dd212c4e2f4029fcc595cfc03ac233aba03d293546aaa5a875b", sizeMB: 284 },
    },
    maxTokens: 512,
  },
};

/** The local folder of a downloaded model, with a clear error if a file is missing. */
export function rerankerPath(name, precision) {
  const model = RERANKERS[name];
  if (!model) throw new Error(`Unknown reranker "${name}". Known: ${Object.keys(RERANKERS).join(", ")}`);
  if (!model.precisions[precision]) throw new Error(`${name} has no "${precision}" precision; one of ${Object.keys(model.precisions).join(", ")}`);
  const dir = `${MODELS_DIR}${model.repository}/`;
  for (const file of [...Object.keys(model.files), model.precisions[precision].file]) {
    if (!existsSync(dir + file)) throw new Error(`Reranker ${name} (${precision}) is not downloaded. Run: npm run models -- ${name} ${precision}`);
  }
  return dir;
}

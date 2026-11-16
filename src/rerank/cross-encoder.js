// A cross-encoder reranker: the model reads the question and one passage together and
// returns a relevance score. Runs locally through transformers.js (ONNX Runtime), from the
// files in models/ only; nothing is fetched at run time.
//
// The model reads at most 512 of its own tokens per pair; a longer pair is truncated
// (passage first). countTokens() reports a pair's length without truncation, so the
// measurements can say how often that happens.
//
// Full precision (fp32) is the default. The quantised file (q8) is a third of the size, but
// its activations are quantised with a scale taken from the whole batch, so a passage's
// score changed by up to 0.08 depending on which other passages it was scored with: its
// rank could depend on the other candidates. fp32 gave the same score in any batch, at the
// same speed (see the README).

import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";
import { MODELS_DIR, RERANKERS, rerankerPath } from "./models.js";

/** @returns {Promise<import("./types.js").Reranker & { countTokens(question: string, passage: string): number }>} */
export async function crossEncoderReranker({ model: name = "mxbai-rerank-xsmall-v1", precision = "fp32", batchSize = 16 } = {}) {
  rerankerPath(name, precision); // a clear error if the files are not downloaded
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;
  const { repository, maxTokens } = RERANKERS[name];
  const tokenizer = await AutoTokenizer.from_pretrained(repository);
  const model = await AutoModelForSequenceClassification.from_pretrained(repository, { dtype: precision });
  return {
    name: `cross-encoder:${name}:${precision}`,
    async score(question, passages) {
      const scores = [];
      for (let i = 0; i < passages.length; i += batchSize) {
        const batch = passages.slice(i, i + batchSize);
        const inputs = tokenizer(new Array(batch.length).fill(question), { text_pair: batch, padding: true, truncation: true, max_length: maxTokens });
        const { logits } = await model(inputs);
        scores.push(...Array.from(logits.data));
      }
      return scores;
    },
    countTokens(question, passage) {
      return tokenizer(question, { text_pair: passage }).input_ids.dims.at(-1);
    },
  };
}

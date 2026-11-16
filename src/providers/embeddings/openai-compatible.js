// Embeddings through OpenAI's API, or any OpenAI-compatible /embeddings endpoint.
// (Anthropic has no embeddings API.)

import { joinUrl, postJson } from "../http.js";

/** @returns {import("../types.js").EmbeddingProvider} */
export function openAICompatibleEmbeddings({ baseUrl = "https://api.openai.com/v1", apiKey, model = "text-embedding-3-small", batchSize = 64, timeoutMs = 60_000 } = {}) {
  return {
    name: `openai-compatible:${model}`,
    async embed(texts, { signal } = {}) {
      const vectors = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const input = texts.slice(i, i + batchSize);
        const response = await postJson(
          joinUrl(baseUrl, "/embeddings"),
          { model, input },
          { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal, timeoutMs },
        );
        const { data } = await response.json();
        if (!Array.isArray(data) || data.length !== input.length) {
          throw new Error(`openai-compatible embeddings: expected ${input.length} vectors, got ${data?.length ?? "none"}`);
        }
        // Results carry their input's index; order by it rather than trusting the array order.
        vectors.push(...[...data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding)));
      }
      return vectors;
    },
  };
}

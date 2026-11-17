// Local LLM through Ollama's native chat API.
//
// The native API is used rather than Ollama's OpenAI-compatible endpoint because only the
// native one accepts `num_ctx`; without it, long conversations are silently truncated to
// the server's default context (measured in the Ollama article of this series).

import { joinUrl, lines, postJson } from "../http.js";

/** @returns {import("../types.js").LLMProvider} */
export function ollamaLLM({
  baseUrl = "http://127.0.0.1:11434",
  model,
  temperature,
  seed,
  numCtx = 8192,
  maxTokens = 1024,
  keepAlive = "10m",
  timeoutMs = 120_000,
}) {
  if (!model) throw new Error("ollama: LLM_MODEL is required");
  const options = { num_ctx: numCtx, num_predict: maxTokens };
  if (temperature !== undefined) options.temperature = temperature;
  if (seed !== undefined) options.seed = seed;
  return {
    name: `ollama:${model}`,
    /** One reply, constrained to a JSON schema with Ollama's `format`. */
    async complete(messages, { schema, signal } = {}) {
      const response = await postJson(
        joinUrl(baseUrl, "/api/chat"),
        { model, messages, stream: false, keep_alive: keepAlive, options, ...(schema ? { format: schema } : {}) },
        { signal, timeoutMs },
      );
      const data = await response.json();
      if (data.error) throw new Error(`ollama: ${data.error}`);
      return {
        text: data.message?.content ?? "",
        stopReason: data.done_reason,
        usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
      };
    },
    async *stream(messages, { signal } = {}) {
      const response = await postJson(
        joinUrl(baseUrl, "/api/chat"),
        { model, messages, stream: true, keep_alive: keepAlive, options },
        { signal, timeoutMs },
      );
      for await (const line of lines(response.body)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(`ollama: ${event.error}`);
        if (event.message?.content) yield event.message.content;
        if (event.done) return;
      }
    },
  };
}

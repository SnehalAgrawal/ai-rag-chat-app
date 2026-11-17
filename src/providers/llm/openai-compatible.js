// Any LLM served through an OpenAI-compatible chat completions API: OpenAI itself, and the
// many providers and servers that expose the same endpoint. Set the base URL, model, and key.

import { joinUrl, postJson, serverSentEvents } from "../http.js";

/** @returns {import("../types.js").LLMProvider} */
export function openAICompatibleLLM({
  baseUrl = "https://api.openai.com/v1",
  apiKey,
  model,
  temperature,
  seed,
  maxTokens = 1024,
  timeoutMs = 60_000,
}) {
  if (!model) throw new Error("openai-compatible: LLM_MODEL is required");
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  return {
    name: `openai-compatible:${model}`,
    /** One reply; with a schema, as strict JSON (response_format json_schema). */
    async complete(messages, { schema, signal } = {}) {
      const body = { model, messages, max_tokens: maxTokens };
      if (temperature !== undefined) body.temperature = temperature;
      if (seed !== undefined) body.seed = seed;
      if (schema) body.response_format = { type: "json_schema", json_schema: { name: "reply", schema, strict: true } };
      const response = await postJson(joinUrl(baseUrl, "/chat/completions"), body, { headers, signal, timeoutMs });
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new Error(`openai-compatible: the model refused (${choice.message.refusal})`);
      return {
        text: choice?.message?.content ?? "",
        stopReason: choice?.finish_reason,
        usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      };
    },
    async *stream(messages, { signal } = {}) {
      const body = { model, messages, stream: true, max_tokens: maxTokens };
      if (temperature !== undefined) body.temperature = temperature;
      if (seed !== undefined) body.seed = seed;
      const response = await postJson(joinUrl(baseUrl, "/chat/completions"), body, { headers, signal, timeoutMs });
      for await (const data of serverSentEvents(response.body)) {
        if (data === "[DONE]") return;
        const event = JSON.parse(data);
        if (event.error) throw new Error(`openai-compatible: ${event.error.message ?? JSON.stringify(event.error)}`);
        const token = event.choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    },
  };
}

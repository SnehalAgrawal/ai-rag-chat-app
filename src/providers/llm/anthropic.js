// Claude through the official Anthropic SDK (@anthropic-ai/sdk), streamed.
//
// Differences from the other LLM providers, from the Claude API documentation:
// - The system prompt is a separate `system` parameter, not a message.
// - Current models reject temperature and seed, so they are not sent.
// - Thinking cannot be turned off on Claude Opus 5.5; its depth is set with
//   output_config.effort. Answers from documents need care more than speed, so the
//   default here is the model's own, "medium" (LLM_EFFORT changes it).
// - Thinking counts against max_tokens, so the default is generous (16,000).
// - If Claude declines a request, the API retries it on a fallback model chosen by the
//   reason (server-side fallbacks, beta "server-side-fallback-2026-07-01").
// The API key comes from LLM_API_KEY, or the SDK's usual ANTHROPIC_API_KEY.

import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** @returns {import("../types.js").LLMProvider} */
export function anthropicLLM({ apiKey, baseUrl, model = DEFAULT_CLAUDE_MODEL, maxTokens = 16000, effort = "medium", timeoutMs = 120_000, client } = {}) {
  const anthropic = client ?? new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseURL: baseUrl } : {}), timeout: timeoutMs });
  const request = (messages, format) => {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns = messages.filter((m) => m.role !== "system").map(({ role, content }) => ({ role, content }));
    return {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: turns,
      output_config: { effort, ...(format ? { format } : {}) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  };
  const declined = (message) =>
    message.stop_reason === "refusal" ? new Error(`anthropic: the request was declined (${message.stop_details?.category ?? "no category"})`) : null;
  return {
    name: `anthropic:${model}`,
    /** One reply; with a schema, as JSON (structured outputs, output_config.format). Streamed, then collected. */
    async complete(messages, { schema, signal } = {}) {
      const stream = anthropic.beta.messages.stream(request(messages, schema ? { type: "json_schema", schema } : null), { signal });
      const message = await stream.finalMessage();
      const error = declined(message);
      if (error) throw error;
      return {
        text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
        stopReason: message.stop_reason,
        usage: { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens },
      };
    },
    async *stream(messages, { signal } = {}) {
      const stream = anthropic.beta.messages.stream(request(messages), { signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      }
      const error = declined(await stream.finalMessage());
      if (error) throw error;
    },
  };
}

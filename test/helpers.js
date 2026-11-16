// Fakes shared by the tests.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An LLM that streams the given text word by word, `delayMs` apart. */
export function fakeLLM(text, { delayMs = 5 } = {}) {
  return {
    name: "fake",
    calls: [],
    async *stream(messages, { signal } = {}) {
      this.calls.push(messages);
      for (const token of text.match(/\S+\s*/g) ?? []) {
        await sleep(delayMs);
        if (signal?.aborted) return;
        yield token;
      }
    },
  };
}

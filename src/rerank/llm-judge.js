// The LLM-as-judge reranker measured in rag-engineering's reranking demo (06-reranking),
// ported with the same prompt, settings, and scoring rule, so its published numbers can be
// reproduced: a local chat model (llama3.2:3b through Ollama) reads the question and one
// passage and answers Yes or No; the score is the log-odds of its first token,
// log P(yes) − log P(no), among the top 20 alternatives. One call per passage.
// Ollama only (it needs token log-probabilities).

import { readFileSync } from "node:fs";
import { joinUrl, postJson } from "../providers/http.js";

const PROMPT = JSON.parse(readFileSync(new URL("./llm-judge-prompt.json", import.meta.url), "utf8"));
export const JUDGE_SETTINGS = {
  options: { temperature: 0, seed: 1, num_predict: 1 },
  topLogprobs: 20,
  yes: ["Yes", "yes", "YES", " Yes", " yes"],
  no: ["No", "no", "NO", " No", " no"],
};

export const judgeMessages = (question, passage) => [
  { role: "system", content: PROMPT.system },
  { role: "user", content: PROMPT.user.replace("{question}", question).replace("{passage}", passage) },
];

function logsumexp(values) {
  const top = Math.max(...values);
  return top + Math.log(values.reduce((s, v) => s + Math.exp(v - top), 0));
}

/** log P(yes labels) − log P(no labels); a label missing from the alternatives gets the lowest listed value. */
export function judgeScore(top, settings = JUDGE_SETTINGS) {
  const floor = Math.min(...Object.values(top));
  const pick = (labels) => {
    const found = labels.filter((t) => t in top).map((t) => top[t]);
    return found.length ? found : [floor];
  };
  return logsumexp(pick(settings.yes)) - logsumexp(pick(settings.no));
}

/** @returns {import("./types.js").Reranker} */
export function llmJudgeReranker({ baseUrl = "http://127.0.0.1:11434", model = "llama3.2:3b", timeoutMs = 120_000 } = {}) {
  return {
    name: `llm-judge:${model}`,
    async score(question, passages, { signal } = {}) {
      const scores = [];
      for (const passage of passages) {
        const response = await postJson(
          joinUrl(baseUrl, "/api/chat"),
          { model, messages: judgeMessages(question, passage), stream: false, options: JUDGE_SETTINGS.options, logprobs: true, top_logprobs: JUDGE_SETTINGS.topLogprobs },
          { signal, timeoutMs },
        );
        const data = await response.json();
        const first = data.logprobs?.[0];
        if (!first) throw new Error("llm-judge: the response has no log-probabilities (this Ollama version may not support logprobs)");
        scores.push(judgeScore(Object.fromEntries(first.top_logprobs.map((t) => [t.token, t.logprob]))));
      }
      return scores;
    },
  };
}

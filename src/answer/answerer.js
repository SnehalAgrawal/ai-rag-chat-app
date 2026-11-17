// Answers a question from a collection, with checked citations.
//
//   1. A follow-up is rewritten into a stand-alone question (rewrite-v1), so retrieval
//      understands "And per year?".
//   2. Retrieval (and reranking) finds the excerpts.
//   3. The relevance gate: if even the best excerpt scores below the tuned threshold, the
//      answer is "not found", without asking the model (the threshold is tuned on dev
//      questions; see scripts/tune-gate.js).
//   4. The model answers in JSON, citing its sources in one of two styles:
//        numbers  excerpt numbers (docs-cited-v1); a number must name an excerpt it was given
//        quotes   exact quotes from the excerpts (docs-quoted-v1); each quote is found in the
//                 excerpts, so a citation can never point at text that doesn't say it
//   5. An answer with no valid citation is flagged "uncited".

import { readFileSync } from "node:fs";

export const PROMPTS = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8"));
const HISTORY_TURNS = 3;

/**
 * @typedef {object} Answer
 * @property {"answered" | "uncited" | "not-found"} status
 * @property {string} answer
 * @property {{ number: number, label: string, document: string, text: string, start: number, end: number }[]} citations
 * @property {number[]} invalidCitations  cited numbers that were not among the excerpts
 * @property {"model" | "gate" | null} declinedBy
 * @property {string} question  the question retrieval used (rewritten, for a follow-up)
 */

export class Answerer {
  /**
   * @param {object} options
   * @param {import("../retrieval/retriever.js").Retriever} options.retriever
   * @param {import("../providers/types.js").LLMProvider} options.llm
   * @param {import("../rerank/types.js").Reranker | null} [options.reranker]
   * @param {{ method: string, budget: number, candidates: number }} options.retrieval
   * @param {{ signal: "vector" | "rerank", threshold: number } | null} [options.gate]
   * @param {boolean} [options.rewrite]
   * @param {"numbers" | "quotes"} [options.citations]
   */
  constructor({ retriever, llm, reranker = null, retrieval, gate = null, rewrite = true, citations = "numbers" }) {
    if (!["numbers", "quotes"].includes(citations)) throw new Error(`Unknown citation style "${citations}"`);
    Object.assign(this, { retriever, llm, reranker, retrieval, gate, rewrite, citationStyle: citations });
    this.prompt = citations === "quotes" ? PROMPTS["answer-quoted"] : PROMPTS.answer;
  }

  /** "And per year?" → "How much does the Pro plan cost per year?" */
  async standalone(question, history, { signal } = {}) {
    if (!this.rewrite || !history.length) return question;
    const conversation = history.slice(-HISTORY_TURNS * 2).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    const reply = await this.llm.complete(
      [
        { role: "system", content: PROMPTS.rewrite.system },
        { role: "user", content: `Conversation:\n${conversation}\n\nLatest message: ${question}` },
      ],
      { schema: PROMPTS.rewrite.schema, signal },
    );
    const rewritten = parseJson(reply.text)?.question?.trim();
    return rewritten || question;
  }

  /**
   * @param {string} question
   * @param {{ history?: { role: "user" | "assistant", content: string }[], signal?: AbortSignal }} [options]
   * @returns {Promise<Answer & { retrieved: object[], timings: object, usage: object, gateSignal: number, promptVersion: string }>}
   */
  async ask(question, { history = [], signal } = {}) {
    const timings = {};
    let started = performance.now();
    const searchQuestion = await this.standalone(question, history, { signal });
    timings.rewriteMs = performance.now() - started;

    const { method, budget, candidates } = this.retrieval;
    const search = await this.retriever.search(searchQuestion, {
      method,
      budget,
      rerank: this.reranker ? { reranker: this.reranker, candidates } : null,
      signal,
    });
    Object.assign(timings, search.timings);
    const retrieved = search.chunks.map(({ label, document, text, tokens, start, end, rerankScore, vectorScore }, i) => ({
      number: i + 1, label, document, text, tokens, start, end, rerankScore, vectorScore,
    }));
    const best = search.best ?? { vector: -Infinity, rerank: null };
    const base = { question: searchQuestion, retrieved, best, promptVersion: this.prompt.version, timings, usage: {} };
    const empty = { answer: "", citations: [], invalidCitations: [] };

    const gateSignal = this.gate ? best[this.gate.signal] : null;
    // A missing signal (e.g. a reranker gate with no reranker) declines: in JavaScript, null >= 0 is true.
    const belowGate = this.gate && (typeof gateSignal !== "number" || !(gateSignal >= this.gate.threshold));
    if (!retrieved.length || belowGate) {
      return { ...base, ...empty, status: "not-found", declinedBy: "gate" };
    }

    const excerpts = retrieved.map((c) => `[${c.number}] ${c.document}\n${c.text}`).join("\n\n");
    const messages = [
      { role: "system", content: this.prompt.system.replace("{excerpts}", excerpts) },
      ...history.slice(-HISTORY_TURNS * 2),
      { role: "user", content: question },
    ];
    started = performance.now();
    const reply = await this.llm.complete(messages, { schema: this.prompt.schema, signal });
    timings.answerMs = performance.now() - started;
    base.usage = reply.usage ?? {};

    const parsed = parseJson(reply.text);
    if (!parsed || typeof parsed.answered !== "boolean") {
      throw new Error(`The model's reply was not the expected JSON${reply.stopReason === "length" ? " (it was cut off at the token limit)" : ""}: ${reply.text.slice(0, 200)}`);
    }
    if (!parsed.answered || !parsed.answer?.trim()) {
      return { ...base, ...empty, status: "not-found", declinedBy: "model" };
    }
    const cite = (n, quote) => {
      const { number, label, document, text, start, end } = retrieved[n - 1];
      return { number, label, document, text, start, end, ...(quote ? { quote } : {}) };
    };
    let citations;
    let invalid;
    if (this.citationStyle === "quotes") {
      const matched = matchQuotes(parsed.quotes, retrieved);
      citations = matched.citations.map(({ number, quote }) => cite(number, quote));
      invalid = matched.unmatched;
    } else {
      const checked = checkCitations(parsed.citations, retrieved.length);
      citations = checked.valid.map((n) => cite(n));
      invalid = checked.invalid;
    }
    return {
      ...base,
      status: citations.length ? "answered" : "uncited",
      declinedBy: null,
      answer: parsed.answer.trim(),
      citations,
      invalidCitations: invalid,
    };
  }
}

const MIN_QUOTE_CHARS = 8;
const normalise = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Finds each quote in the excerpts (ignoring case and spacing). A quote shorter than
 * 8 characters, or found nowhere, is unmatched. Excerpts are cited once, in quote order.
 */
export function matchQuotes(quotes, excerpts) {
  const texts = excerpts.map((e) => normalise(e.text));
  const citations = [];
  const unmatched = [];
  for (const raw of Array.isArray(quotes) ? quotes : []) {
    if (typeof raw !== "string") {
      unmatched.push(raw);
      continue;
    }
    const quote = normalise(raw.replace(/^["'“‘\s]+|["'”’\s]+$/g, ""));
    const index = quote.length >= MIN_QUOTE_CHARS ? texts.findIndex((t) => t.includes(quote)) : -1;
    if (index === -1) {
      unmatched.push(raw);
      continue;
    }
    const number = excerpts[index].number;
    const existing = citations.find((c) => c.number === number);
    if (existing) existing.quote = `${existing.quote} … ${raw.trim()}`;
    else citations.push({ number, quote: raw.trim() });
  }
  return { citations, unmatched };
}

/** Citations that name an excerpt the model was given, in order, without repeats; the rest. */
export function checkCitations(citations, excerptCount) {
  const valid = [];
  const invalid = [];
  for (const n of Array.isArray(citations) ? citations : []) {
    if (Number.isInteger(n) && n >= 1 && n <= excerptCount) {
      if (!valid.includes(n)) valid.push(n);
    } else invalid.push(n);
  }
  return { valid, invalid };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

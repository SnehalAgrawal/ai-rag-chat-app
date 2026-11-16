// Token counts. With the Llama 3.2 tokenizer file present, counts are exact (the same
// byte-level BPE as rag-engineering's demos, with Llama 3's full Unicode pre-tokenizer);
// without it, an estimate of one token per four characters.
//
// The tokenizer file is under Meta's Llama 3.2 Community License, so it is not committed:
// put it at models/tokenizer.json (or set TOKENIZER_PATH). The measurements need it, so
// that chunks and budgets match the published numbers exactly; the app runs without it.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_TOKENIZER_PATH = fileURLToPath(new URL("../../models/tokenizer.json", import.meta.url));

// Llama 3's pre-tokenizer pattern.
const PATTERN =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function byteToUnicode() {
  // The byte-level alphabet: every byte gets a printable character (as in GPT-2 and Llama 3).
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const printable = [...range(0x21, 0x7e), ...range(0xa1, 0xac), ...range(0xae, 0xff)];
  const codes = [...printable];
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!printable.includes(b)) {
      printable.push(b);
      codes.push(256 + extra);
      extra += 1;
    }
  }
  return new Map(printable.map((b, i) => [b, String.fromCharCode(codes[i])]));
}

const BYTE_TO_UNICODE = byteToUnicode();
const UNICODE_TO_BYTE = new Map([...BYTE_TO_UNICODE].map(([b, c]) => [c, b]));

export class LlamaTokenizer {
  constructor(path) {
    const model = JSON.parse(readFileSync(path, "utf8")).model;
    this.name = "llama-3.2";
    this.exact = true;
    this.vocab = new Map(Object.entries(model.vocab));
    this.idToToken = new Map([...this.vocab].map(([t, i]) => [i, t]));
    this.ranks = new Map();
    model.merges.forEach((m, rank) => {
      const [a, b] = Array.isArray(m) ? m : m.split(" ");
      this.ranks.set(`${a} ${b}`, rank);
    });
    this.cache = new Map();
  }

  bpe(piece) {
    if (this.vocab.has(piece)) return [this.vocab.get(piece)]; // ignore_merges: a known piece stays whole
    const parts = [...piece];
    while (parts.length > 1) {
      let best = null;
      for (let i = 0; i < parts.length - 1; i++) {
        const rank = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (rank !== undefined && (best === null || rank < best.rank)) best = { rank, i };
      }
      if (best === null) break;
      parts.splice(best.i, 2, parts[best.i] + parts[best.i + 1]);
    }
    return parts.map((p) => this.vocab.get(p));
  }

  encode(text) {
    const ids = [];
    for (const piece of text.match(PATTERN) || []) {
      if (!this.cache.has(piece)) {
        const bytes = [...Buffer.from(piece, "utf8")].map((b) => BYTE_TO_UNICODE.get(b)).join("");
        this.cache.set(piece, this.bpe(bytes));
      }
      ids.push(...this.cache.get(piece));
    }
    return ids;
  }

  decode(ids) {
    const bytes = ids.flatMap((i) => [...this.idToToken.get(i)].map((c) => UNICODE_TO_BYTE.get(c)));
    return Buffer.from(bytes).toString("utf8");
  }

  count(text) {
    return this.encode(text).length;
  }
}

/** One token per four characters, rounded up: close to Llama 3 on English prose. */
export class EstimatedTokens {
  constructor() {
    this.name = "estimate";
    this.exact = false;
  }

  count(text) {
    return Math.ceil(text.length / 4);
  }

  /** Splits into pieces of about four characters, so fixed-size chunking still works. */
  encode(text) {
    return Array.from({ length: this.count(text) }, (_, i) => i);
  }

  decodeSpan(text, startToken, endToken) {
    return text.slice(startToken * 4, endToken * 4);
  }
}

/** The exact tokenizer when its file is present, otherwise the estimate. */
export function loadTokenizer(path = process.env.TOKENIZER_PATH || DEFAULT_TOKENIZER_PATH) {
  return existsSync(path) ? new LlamaTokenizer(path) : new EstimatedTokens();
}

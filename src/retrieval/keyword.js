// Keyword search: BM25 as in Lucene, ported from rag-engineering's hybrid-search demo
// (05-hybrid-search/javascript/search.js), where each rule is described.

const WORD = /[a-z0-9]+/g;
const IDENTIFIER = /[a-z0-9]+(?:[-_./:]+[a-z0-9]+)+/g;

/**
 * "words": lowercase runs of letters and digits ("SSO-104" → "sso", "104").
 * "identifiers": the words, plus each identifier kept whole ("SSO-104" → also "sso-104").
 */
export function analyze(text, analyzer = "words") {
  const lowered = text.toLowerCase();
  const tokens = lowered.match(WORD) || [];
  if (analyzer === "identifiers") tokens.push(...(lowered.match(IDENTIFIER) || []));
  else if (analyzer !== "words") throw new Error(`unknown analyzer ${analyzer}`);
  return tokens;
}

/** BM25 with Lucene's idf: ln(1 + (N - df + 0.5) / (df + 0.5)). */
export class BM25 {
  constructor(texts, { analyzer = "words", k1 = 1.2, b = 0.75 } = {}) {
    Object.assign(this, { analyzer, k1, b });
    this.counts = texts.map((text) => {
      const counts = new Map();
      for (const token of analyze(text, analyzer)) counts.set(token, (counts.get(token) || 0) + 1);
      return counts;
    });
    this.lengths = this.counts.map((c) => [...c.values()].reduce((s, v) => s + v, 0));
    this.averageLength = this.lengths.length ? this.lengths.reduce((s, v) => s + v, 0) / this.lengths.length : 0;
    const df = new Map();
    for (const counts of this.counts) for (const token of counts.keys()) df.set(token, (df.get(token) || 0) + 1);
    const n = texts.length;
    this.idf = new Map([...df].map(([t, d]) => [t, Math.log(1 + (n - d + 0.5) / (d + 0.5))]));
  }

  /** One score per text; 0 for a text with none of the query's tokens. */
  scores(query) {
    const tokens = analyze(query, this.analyzer);
    return this.counts.map((counts, i) => {
      let score = 0;
      const norm = this.k1 * (1 - this.b + (this.b * this.lengths[i]) / this.averageLength);
      for (const token of tokens) {
        // each query token counts once per occurrence
        const tf = counts.get(token) || 0;
        if (tf) score += (this.idf.get(token) * tf * (this.k1 + 1)) / (tf + norm);
      }
      return score;
    });
  }
}

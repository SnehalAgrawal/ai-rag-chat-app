// Ranking and fusion, ported from rag-engineering's hybrid-search demo. Every ranking breaks
// ties by chunk order, so results are deterministic.

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Indexes, best score first; ties by index. matchedOnly drops scores of 0 (no keyword in common). */
export function rank(scores, matchedOnly = false) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  return matchedOnly ? order.filter((i) => scores[i] > 0) : order;
}

/** Reciprocal rank fusion: each ranking adds 1 / (k + rank) to every index in it, ranks from 1. */
export function rrf(rankings, k, size) {
  const fused = new Array(size).fill(0);
  for (const ranking of rankings) ranking.forEach((i, position) => (fused[i] += 1 / (k + position + 1)));
  return fused;
}

export function minMax(scores) {
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  return high === low ? scores.map(() => 0) : scores.map((s) => (s - low) / (high - low));
}

/** alpha × normalised vector score + (1 − alpha) × normalised keyword score, normalised per query. */
export function weighted(vectorScores, keywordScores, alpha) {
  const v = minMax(vectorScores);
  const k = minMax(keywordScores);
  return v.map((a, i) => alpha * a + (1 - alpha) * k[i]);
}

/** Indexes in rank order that fit the token budget; one that doesn't fit what is left is skipped. */
export function withinBudget(ranked, tokens, budget) {
  const chosen = [];
  let used = 0;
  for (const i of ranked) {
    if (used + tokens[i] <= budget) {
      chosen.push(i);
      used += tokens[i];
    }
  }
  return chosen;
}

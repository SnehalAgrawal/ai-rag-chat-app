// Structure-aware chunking: the strategy that won rag-engineering's chunking comparison
// (04-chunking: 29 of 29 test questions at a 1,000-token budget). Ported from its
// JavaScript version; test/chunker.test.js checks the chunks are identical.
//
// Every chunk is one slice of one document, document.slice(start, end), exactly as written,
// with the heading lines above the slice copied in front, so a chunk keeps its context.
// Sections are kept whole when they fit in maxTokens; larger ones are packed block by block
// (paragraphs, tables, lists, code blocks), and a single line that is still too big is cut
// into token windows.

const HEADING = /^#{1,6} /;

export function parseLines(text) {
  const lines = [];
  let position = 0;
  let inCode = false;
  for (const raw of text.split("\n")) {
    const start = position;
    const end = position + raw.length;
    position = end + 1;
    let kind;
    if (raw.startsWith("```")) {
      kind = "fence";
      inCode = !inCode;
    } else if (inCode) kind = "code";
    else if (raw.trim() === "") kind = "blank";
    else if (HEADING.test(raw)) kind = "heading";
    else kind = "text";
    lines.push({ start, end, text: raw, kind });
  }
  return lines;
}

/** Paragraphs, tables, lists, and code blocks: runs of lines between blank lines. A heading is its own block. */
export function blocks(lines) {
  const result = [];
  let current = [];
  for (const line of lines) {
    if (line.kind === "blank" || line.kind === "heading") {
      if (current.length) result.push(current);
      current = [];
      if (line.kind === "heading") result.push([line]);
    } else current.push(line);
  }
  if (current.length) result.push(current);
  return result;
}

const level = (line) => line.text.length - line.text.replace(/^#+/, "").length;

/** The headings in force at a position: the last heading of each level above it, outermost first. */
export function headingStack(lines, position) {
  let stack = [];
  for (const line of lines) {
    if (line.start > position) break;
    if (line.kind === "heading") stack = [...stack.filter((h) => level(h) < level(line)), line];
  }
  return stack;
}

/** Joins consecutive spans while the joined slice stays within maxTokens; splits a span that is too big alone. */
function pack(spans, document, maxTokens, count, split) {
  const result = [];
  let current = null;
  for (const span of spans) {
    if (count(document.slice(span[0], span[1])) > maxTokens) {
      if (current) result.push(current);
      current = null;
      result.push(...split(span));
      continue;
    }
    if (current && count(document.slice(current[0], span[1])) <= maxTokens) current = [current[0], span[1]];
    else {
      if (current) result.push(current);
      current = span;
    }
  }
  if (current) result.push(current);
  return result;
}

/** Fixed windows of `size` tokens, `overlap` tokens shared between neighbours, as [start, end] offsets. */
export function fixed(text, size, overlap, tokenizer) {
  if (!tokenizer.exact) {
    // The estimate has no real tokens: windows of size × 4 characters.
    const spans = [];
    for (let start = 0; ; start += (size - overlap) * 4) {
      const end = Math.min(start + size * 4, text.length);
      spans.push([start, end]);
      if (end === text.length) return spans;
    }
  }
  const ids = tokenizer.encode(text);
  const offsets = [0];
  for (const token of ids) offsets.push(offsets[offsets.length - 1] + tokenizer.decode([token]).length);
  const spans = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + size, ids.length);
    spans.push([offsets[start], offsets[end]]);
    if (end === ids.length) return spans;
    start += size - overlap;
  }
}

/** Section-by-section spans, each within maxTokens. */
export function structure(text, maxTokens, tokenizer) {
  const count = (t) => tokenizer.count(t);
  const lines = parseLines(text);
  const headings = lines.flatMap((line, i) => (line.kind === "heading" ? [i] : []));
  const starts = [...(headings.length && headings[0] !== 0 ? [0] : []), ...headings];
  if (!starts.length) starts.push(0);
  const sections = [];
  let pending = null;
  starts.forEach((first, k) => {
    const last = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const content = lines.slice(first, last).filter((line) => line.kind !== "blank");
    if (!content.length) return;
    const begin = pending !== null ? pending : content[0].start;
    if (content.every((line) => line.kind === "heading")) {
      pending = begin; // a heading with nothing under it joins the next section
      return;
    }
    sections.push([begin, content[content.length - 1].end, blocks(lines.slice(first, last))]);
    pending = null;
  });

  const splitLine = (span) => fixed(text.slice(span[0], span[1]), maxTokens, 0, tokenizer).map(([a, b]) => [span[0] + a, span[0] + b]);
  const splitBlock = (span) => {
    const blockLines = lines.filter((line) => span[0] <= line.start && line.end <= span[1]);
    return pack(blockLines.map((line) => [line.start, line.end]), text, maxTokens, count, splitLine);
  };

  const result = [];
  for (const [begin, end, sectionBlocks] of sections) {
    if (count(text.slice(begin, end)) <= maxTokens) {
      result.push([begin, end]);
      continue;
    }
    const spans = sectionBlocks.map((b) => [b[0].start, b[b.length - 1].end]);
    spans[0] = [begin, spans[0][1]]; // keep a merged empty heading with the first block
    result.push(...pack(spans, text, maxTokens, count, splitBlock));
  }
  return result;
}

/**
 * Chunks one document.
 * @param {string} name
 * @param {string} text
 * @param {{ kind?: "structure" | "fixed", maxTokens?: number, size?: number, overlap?: number, headings?: boolean }} strategy
 * @param {{ count(text: string): number }} tokenizer
 */
export function chunkDocument(name, text, strategy, tokenizer) {
  const { kind = "structure", maxTokens = 512, size = 256, overlap = 0, headings = kind === "structure" } = strategy;
  const spans = kind === "structure" ? structure(text, maxTokens, tokenizer) : fixed(text, size, overlap, tokenizer);
  const lines = parseLines(text);
  return spans.map(([start, end], n) => {
    let prefix = "";
    if (headings) {
      const above = headingStack(lines, start).filter((h) => !(start <= h.start && h.start < end)).map((h) => h.text);
      prefix = above.length ? `${above.join("\n")}\n\n` : "";
    }
    const body = prefix + text.slice(start, end);
    return { id: `${name.replace(/\.[a-z]+$/i, "")}#${n + 1}`, document: name, ordinal: n + 1, start, end, prefix, text: body, tokens: tokenizer.count(body) };
  });
}

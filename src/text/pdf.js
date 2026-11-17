// Text from a PDF, with its structure rebuilt as Markdown so the structure-aware chunker
// works on it: lines larger than the body text become headings (levels by size, largest
// first), lines wrapped inside a paragraph are joined back into one line, and blocks are
// separated by blank lines.
//
// Tables: a wide gap inside a line separates columns. Within one table row, pieces that
// start at the same position belong to one cell, so a cell that wraps onto a second line is
// joined top to bottom, then the cells are joined with " | ". Joining each visual line left
// to right instead interleaves the cells ("...signed with an Add the identity provider's
// current active certificate certificate..."), which lost 5 of 170 evidence passages.
//
// Uses PDF.js (pdfjs-dist, Apache-2.0). It reads the text a PDF contains; a scanned page
// (an image of text) has none, and comes back empty.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const HEADING_RATIO = 1.15; // a line at least 15% larger than the body text is a heading
const MAX_HEADING_LEVELS = 3;

/**
 * @param {Uint8Array} data  the PDF file's bytes
 * @returns {Promise<{ text: string, pages: number, headings: number }>}
 */
export async function extractPdf(data) {
  const task = getDocument({ data, useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const pages = pdf.numPages;
  const lines = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      lines.push(...pageLines(content.items, p));
    }
  } finally {
    await task.destroy();
  }
  return { ...toMarkdown(lines), pages };
}

/** Text items grouped into lines (same baseline), top to bottom, left to right. */
export function pageLines(items, page) {
  const rows = [];
  for (const item of items) {
    // PDF.js adds whitespace-only items that span the gap between table cells; gaps are
    // measured between real text instead, so the cells can be told apart.
    if (!item.str || !item.str.trim()) continue;
    const [a, b, , , x, y] = item.transform;
    const size = Math.round(Math.hypot(a, b) * 10) / 10;
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(1.5, size * 0.3));
    if (!row) {
      row = { page, y, size, items: [] };
      rows.push(row);
    }
    row.size = Math.max(row.size, size);
    row.items.push({ x, width: item.width, str: item.str });
  }
  rows.sort((r, s) => s.y - r.y);
  return rows
    .map((row) => {
      const parts = row.items.sort((i, j) => i.x - j.x);
      const segments = [];
      let current = null;
      let end = null;
      for (const part of parts) {
        const gap = end === null ? 0 : part.x - end;
        // A word space is about a quarter of the font size; a table cell's padding and border
        // are about half or more. So a gap over 0.45 × the font size starts a new column.
        if (!current || gap > row.size * 0.45) {
          current = { x: part.x, text: "" };
          segments.push(current);
        } else if (gap > row.size * 0.15 && !current.text.endsWith(" ") && !part.str.startsWith(" ")) {
          current.text += " ";
        }
        current.text += part.str;
        end = part.x + part.width;
      }
      const cleaned = segments.map((g) => ({ x: g.x, text: g.text.replace(/\s+/g, " ").trim() })).filter((g) => g.text);
      return { page: row.page, y: row.y, size: row.size, segments: cleaned, text: cleaned.map((g) => g.text).join(" ") };
    })
    .filter((l) => l.text);
}

/** One table row from its visual lines: segments grouped into columns by position, each read top to bottom. */
export function tableRow(lines) {
  const columns = [];
  for (const line of lines) {
    for (const segment of line.segments) {
      let column = columns.find((c) => Math.abs(c.x - segment.x) < line.size);
      if (!column) {
        column = { x: segment.x, parts: [] };
        columns.push(column);
      }
      column.parts.push(segment.text);
    }
  }
  return columns
    .sort((a, b) => a.x - b.x)
    .map((c) => c.parts.join(" "))
    .join(" | ");
}

/** Lines → Markdown: headings by font size, paragraphs re-joined, blocks separated by blank lines. */
export function toMarkdown(lines) {
  if (!lines.length) return { text: "", headings: 0 };
  // The body size is the one most of the text is set in.
  const weight = new Map();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  const body = [...weight].sort((a, b) => b[1] - a[1])[0][0];
  const headingSizes = [...new Set(lines.filter((l) => l.size >= body * HEADING_RATIO).map((l) => l.size))]
    .sort((a, b) => b - a)
    .slice(0, MAX_HEADING_LEVELS);
  const levelOf = (size) => headingSizes.indexOf(size) + 1;

  const blocks = [];
  let current = null;
  let previous = null;
  let headings = 0;
  for (const line of lines) {
    const level = levelOf(line.size);
    if (level > 0) {
      blocks.push(`${"#".repeat(level)} ${line.text}`);
      headings++;
      current = null;
    } else {
      const gap = previous && previous.page === line.page ? previous.y - line.y : Infinity;
      const newBlock = !current || previous.size !== line.size || gap > line.size * 1.9;
      // A list item or table row keeps its own line inside the block.
      const ownLine = /^([•◦▪\-–]|\d+\.)\s/.test(line.text) || /\s\|\s/.test(line.text);
      if (newBlock) {
        current = [line.text];
        current.lines = [line];
        blocks.push(current);
      } else if (ownLine || current.ownLines) {
        current.push(line.text);
        current.lines.push(line);
        current.ownLines = current.ownLines || ownLine;
      } else {
        current[current.length - 1] += ` ${line.text}`;
        current.lines.push(line);
      }
    }
    previous = line;
  }
  // A block with more than one column on any line is a table row.
  const render = (b) => (!Array.isArray(b) ? b : b.lines.some((l) => l.segments.length > 1) ? tableRow(b.lines) : b.join("\n"));
  const text = blocks.map(render).join("\n\n");
  return { text: `${text}\n`, headings };
}

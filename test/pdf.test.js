import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDocument } from "../src/ingest.js";
import { pageLines, tableRow, toMarkdown } from "../src/text/pdf.js";

/** A PDF.js text item at (x, y), 11 pt, with a width. */
const item = (str, x, y, width, size = 11) => ({ str, transform: [size, 0, 0, size, x, y], width });

test("lines: whitespace items are skipped, wide gaps start columns, ligature pieces join without a space", () => {
  const [line] = pageLines(
    [item("SSO-101", 57.7, 565, 45.2), item(" ", 103, 565, 19.2), item("The response was", 117.4, 565, 90), item("certi", 210, 565, 21.4), item("fi", 231.4, 565, 5.7), item("cate", 237.1, 565, 21.2)],
    1,
  );
  assert.deepEqual(line.segments.map((s) => s.text), ["SSO-101", "The response was certificate"]);
  assert.equal(line.text, "SSO-101 The response was certificate");
});

test("a monospaced font's word spaces (0.6 × the font size) don't start columns; a two-space gap does", () => {
  // Courier-like: every character 0.6 em wide, each word its own item, one space between.
  const words = (text, x, y) => {
    const out = [];
    for (const word of text.split(" ")) {
      out.push(item(word, x, y, word.length * 6.6));
      x += (word.length + 1) * 6.6;
    }
    return out;
  };
  const [prose] = pageLines(words("Receipts must be submitted within 30 days.", 17, 600), 1);
  assert.deepEqual(prose.segments.map((s) => s.text), ["Receipts must be submitted within 30 days."]);
  const [table] = pageLines([...words("Pro", 17, 580), ...words("$25", 17 + 5 * 6.6, 580)], 1);
  assert.deepEqual(table.segments.map((s) => s.text), ["Pro", "$25"]);
});

test("a table row's wrapped cells are rebuilt by column, then joined with |", () => {
  const lines = [
    { size: 11, segments: [{ x: 57, text: "SSO-103" }, { x: 117, text: "The email address doesn't match any" }, { x: 327, text: "Invite the person, or check the NameID" }] },
    { size: 11, segments: [{ x: 117, text: "member" }, { x: 327, text: "format (step 3)" }] },
  ];
  assert.equal(tableRow(lines), "SSO-103 | The email address doesn't match any member | Invite the person, or check the NameID format (step 3)");
});

test("headings by size, largest first; wrapped paragraph lines joined; blocks separated", () => {
  const line = (text, size, y, x = 50) => ({ page: 1, y, size, text, segments: [{ x, text }] });
  const { text, headings } = toMarkdown([
    line("Guide", 22, 800),
    line("Setup", 16, 760),
    line("Install the app on every", 11, 740),
    line("computer you use.", 11, 727),
    line("Then sign in.", 11, 690),
    line("Details", 13, 660),
    line("More text here.", 11, 640),
  ]);
  assert.equal(headings, 3);
  assert.equal(text, "# Guide\n\n## Setup\n\nInstall the app on every computer you use.\n\nThen sign in.\n\n### Details\n\nMore text here.\n");
});

test("a real PDF from the evaluation set: headings and table rows come back", async () => {
  const { name, text } = await readDocument(new URL("../eval/pdf/billing-guide.pdf", import.meta.url).pathname);
  assert.equal(name, "billing-guide.pdf");
  assert.match(text, /^# Billing and Plans Guide$/m);
  assert.match(text, /^## Plans at a glance$/m);
  assert.match(text, /^Annual price \| \$100 \| \$250$/m);
  assert.match(text, /Prices are per organization, not per member, and don't include tax\./);
});

test("a PDF in a monospaced font (made by macOS, not Chrome) comes back as prose, not as a table", async () => {
  const { text } = await readDocument(new URL("../samples/remote-work-policy.pdf", import.meta.url).pathname);
  assert.match(text, /^This is a fictional policy written to demonstrate the RAG chat app\./m);
  assert.match(text, /Remote employees must be reachable between 10:00 and 16:00 in their team's home time zone\./);
  assert.doesNotMatch(text, / \| /);
});

test("code blocks in the evaluation PDFs (a monospaced font) aren't split into columns", async () => {
  const { text } = await readDocument(new URL("../eval/pdf/api-reference.pdf", import.meta.url).pathname);
  assert.match(text, /\{ "error": \{ "code": "validation_failed", "message": "title must not be empty", "request_id": "req_4t7hq2" \} \}/);
});

test("a PDF with no text (a scan) is refused with a reason", async () => {
  // A minimal valid PDF: one empty page, no text.
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const dir = await mkdtemp(join(tmpdir(), "rag-pdf-"));
  try {
    await writeFile(join(dir, "scan.pdf"), pdf);
    await assert.rejects(readDocument(join(dir, "scan.pdf")), /scan\.pdf: no text found in 1 page\(s\); a scanned PDF needs OCR first/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

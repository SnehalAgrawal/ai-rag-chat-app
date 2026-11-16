import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_TOKENIZER_PATH, EstimatedTokens, LlamaTokenizer, loadTokenizer } from "../src/text/tokens.js";

const path = process.env.TOKENIZER_PATH || DEFAULT_TOKENIZER_PATH;
const exact = existsSync(path);

test("without the tokenizer file, counts are estimated at four characters per token", () => {
  const tokenizer = loadTokenizer("/nonexistent/tokenizer.json");
  assert.equal(tokenizer.exact, false);
  assert.equal(tokenizer.count("12345678"), 2);
  assert.equal(tokenizer.count("123456789"), 3);
  assert.equal(new EstimatedTokens().count(""), 0);
});

test("the Llama 3.2 tokenizer round-trips text, including non-ASCII", { skip: exact ? false : "needs models/tokenizer.json" }, () => {
  const tokenizer = new LlamaTokenizer(path);
  for (const text of ["Hello, world!", "SSO-104 means the Entity ID doesn't match.", "Café déjà vu – naïve 東京 🙂", "  spaces\n\nand\tlines  "]) {
    assert.equal(tokenizer.decode(tokenizer.encode(text)), text);
  }
  assert.equal(tokenizer.count("Hello, world!"), 4);
});

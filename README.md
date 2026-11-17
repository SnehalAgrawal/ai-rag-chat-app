# AI RAG Chat App

Chat with your documents: answers that cite the passages they came from, built on what [rag-engineering](https://github.com/SnehalAgrawal/rag-engineering) measured about chunking, hybrid search, and reranking. It runs locally with **no accounts and no API keys**, and OpenAI or Claude are a setting away.

> **Status: being rebuilt.** This branch replaces the 2025 app (Next.js, Express, Weaviate, one PDF at a time, no citations), which is still on `main`. The plan, in order:
>
> 1. **Foundation** (done): the chunker, document storage, ingest, and the model providers, with tests.
> 2. **Retrieval** (done): vector and keyword search fused with RRF, matching rag-engineering's published numbers exactly.
> 3. **Reranking** (done): a cross-encoder, measured against no reranking and against an LLM judge (whose published numbers are reproduced exactly).
> 4. **Answers** (done): checked citations, follow-up questions, and a relevance gate (measured, and off by default).
> 5. **PDF documents** (done): text extracted with headings and tables rebuilt; on these documents, nothing lost.
> 6. The web app.
> 7. Measurements and the README.

## What works now

- **Chunking** ([`src/text/chunker.js`](src/text/chunker.js)): structure-aware chunks with the headings above each chunk copied in. This was the strategy that won rag-engineering's chunking comparison: 29 of 29 test questions at a 1,000-token budget. It's ported from there, and a test checks it makes exactly the same 98 chunks (10,913 tokens) on the same documents.
- **Storage** ([`src/store/store.js`](src/store/store.js)): documents, chunks, and embeddings in one SQLite file, using Node's built-in `node:sqlite`, so nothing native needs installing.
  - Documents are content-hashed: adding the same text again changes nothing, and changed text replaces the old chunks.
  - Each embedding is stored with the name of the model that made it.
  - Ids are never reused, so a citation can't silently point at different text after a document changes.
- **Ingest:** `npm run ingest -- --collection docs path/to/*.md path/to/*.pdf` (Markdown, text, and PDF).
- **Retrieval** ([`src/retrieval/`](src/retrieval/)): four ways to rank chunks for a question, with the chosen chunks filling a token budget in rank order:
  - **vector:** cosine similarity of embeddings;
  - **keyword:** BM25, which returns only chunks sharing a word with the question;
  - **rrf** (the default): reciprocal rank fusion of the two;
  - **weighted:** a weighted mix of the two scores.

  Search is exact and filtered to one collection before scoring. Chunks are embedded when they're missing an embedding, or when it came from a different model than the current one.
- **Reranking** ([`src/rerank/`](src/rerank/)): a cross-encoder, [`mxbai-rerank-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1) (Apache-2.0), reads the question and each candidate together and reorders the top 10. It runs locally through [transformers.js](https://github.com/huggingface/transformers.js) (ONNX Runtime), from files downloaded at a pinned revision and checked against their SHA-256s. The default is vector search's top 10, reranked.
- **Model providers** ([`src/providers/`](src/providers/)): answers from Ollama, OpenAI (or any OpenAI-compatible API), or Claude; embeddings from Ollama or OpenAI.
  - Ollama embeddings run with `truncate: false`. By default Ollama silently cuts input longer than the model's context, which in rag-engineering's chunking measurements left the evidence for 9 questions unembedded. Here an over-long input is an error instead.
  - `nomic-embed-text` gets its `search_document:` and `search_query:` prefixes added automatically.

## Run it

Requires Node.js 24 or newer, and [Ollama](https://ollama.com):

```bash
ollama pull nomic-embed-text
npm install
npm run models           # the reranker, 284 MB, checksums verified
npm run ingest -- --collection eval eval/documents/*.md
npm run check            # lint and tests; no network needed
npm run eval:retrieval   # retrieval on the frozen questions, against the published numbers
npm run eval:rerank      # reranking, likewise (the LLM judge takes about 10 minutes)
npm run eval:pdf         # the same documents as PDF: what extraction keeps
```

`npm install` brings in ONNX Runtime for the reranker, and the dependency folder comes to about 520 MB.

### The tokenizer (optional, for exact token counts)

Chunk sizes and retrieval budgets are counted in Llama 3.2 tokens, as in rag-engineering, so the measurements can be compared with its published numbers. The tokenizer file (17 MB) is under the Llama 3.2 Community License, so it isn't stored in this repository. Download the same file rag-engineering uses, pinned to a revision, and check it:

```bash
mkdir -p models
curl -L -o models/tokenizer.json \
  https://huggingface.co/mlx-community/Llama-3.2-1B-Instruct-4bit/resolve/08231374eeacb049a0eade7922910865b8fce912/tokenizer.json
shasum -a 256 models/tokenizer.json   # 6b9e4e7fb171f92fd137b777cc2714bf87d11576700a1dcd7a399e7bbe39537b
```

Set `TOKENIZER_PATH` if you already have it elsewhere.

Without it, tokens are estimated at four characters each. The app works the same; the chunks just differ slightly from the measured ones. The test that compares chunks with rag-engineering's is skipped without the tokenizer.

## Retrieval, checked against the published numbers

`npm run eval:retrieval` runs rag-engineering's 100 frozen questions through this app's own code: its ingest, store, embeddings and retriever. It counts a question as found when every passage of one of its accepted answers is inside the chunks that fit the budget. It needs the tokenizer (above) and Ollama with `nomic-embed-text`.

Every number matched the ones [rag-engineering's hybrid-search demo](https://github.com/SnehalAgrawal/rag-engineering/tree/main/05-hybrid-search) published for the same documents and model (35 of 35). Here are the 48 test questions, by budget:

| Method | 500 tokens | 1,000 tokens | 2,000 tokens |
|---|---|---|---|
| vector | 41 | 46 | 48 |
| keyword (BM25) | 41 | 45 | 46 |
| **RRF** | **45** | **47** | 47 |
| weighted (alpha 0.8) | 43 | 46 | 48 |

Recorded on 2026-11-16, on an Apple M4 Pro with Node 24.16.0, Ollama 0.40.16 and `nomic-embed-text` (`0a109f422b47`). The match holds whether the chunks are embedded fresh or read back from the database. Embedding a question took a median of 8–9 ms.

RRF is the default because it found the most evidence when the budget was small. Reranking, the next step, is measured on top of it.

## Reranking, measured

`npm run eval:rerank` reranks the first stage's top 10 or 20 candidates, then fills the budget from the new order; a chunk outside the candidates is never used. As in [rag-engineering's reranking demo](https://github.com/SnehalAgrawal/rag-engineering/tree/main/06-reranking), it builds every (question, chunk) pair in the top 20 of either first stage, which is 2,581 pairs, and scores each pair once. It compares three ways of ordering the candidates:

- **first stage:** no reranking.
- **LLM judge:** the demo's reranker. `llama3.2:3b` answers Yes or No for each pair, and the score is the log-odds of its first token.
- **cross-encoder:** `mxbai-rerank-xsmall-v1`, new here.

**The LLM judge reproduced the demo exactly.** Every published number matched: candidate recall, evidence found by budget, and evidence found by question group. So the comparison below is like for like.

Evidence found for the 48 test questions:

| First stage → reranker | 500 tokens | 1,000 tokens | 2,000 tokens |
|---|---|---|---|
| RRF, no reranking | 45 | 47 | 47 |
| vector, no reranking | 41 | 46 | 48 |
| vector top 10 → LLM judge | **46** | **48** | 48 |
| vector top 10 → **cross-encoder** | 45 | **48** | 48 |
| vector top 20 → LLM judge | 45 | 47 | 48 |
| vector top 20 → cross-encoder | 44 | 47 | 48 |
| RRF top 10 → LLM judge | 44 | 47 | 47 |
| RRF top 10 → cross-encoder | 43 | 46 | 47 |

What this shows:

- **The cross-encoder matches the LLM judge at the default budget of 1,000 tokens.** Both find 48 of 48 when they rerank vector search's top 10. At 500 tokens the cross-encoder finds one question fewer (45 against 46).
- **The cross-encoder is much cheaper.** It reranked 10 candidates in about 0.26 s. The LLM judge makes one call per candidate, and took 197 ms per call in this run, so about 2 s for 10. Both timings are from a run on battery power, so they're indicative only; the demo measured 166–184 ms per judge call on mains power.
- **So the default is vector search's top 10, reranked by the cross-encoder.** It finds 48 at 1,000 tokens, against 47 for RRF without reranking.
- **Reranking RRF's candidates made results slightly worse** with either reranker, as the demo found. RRF's order was already good where it had the evidence. That's why the app reranks vector search's candidates instead.
- **No candidate was truncated.** The cross-encoder reads at most 512 of its own tokens per pair, and the longest of the 2,581 pairs was 503.
- **The quantised model (q8) isn't the default, though it's a third of the size.** It found the same questions here, but its score for a passage depended on which other passages were scored in the same batch: one passage scored −1.343 alone and −1.412 or −1.427 alongside others. That's because its activations are quantised with a scale taken from the whole batch. So with it, a passage's rank could depend on the other candidates. The full-precision model gave identical scores in any batch, at the same speed. A test checks this.

Recorded on 2026-11-16 on an Apple M4 Pro, on battery power, with Node 24.16.0, Ollama 0.40.16, `nomic-embed-text` (`0a109f422b47`), `llama3.2:3b` (`a80c4f17acd5`), transformers.js 4.3.2, and `mxbai-rerank-xsmall-v1` at revision `b5c6e9da`. The counts don't depend on power. The timings will be measured again on mains power for the final measurements.

## Answers, measured

[`src/answer/`](src/answer/) answers a question in four steps:
1. **Rewrite a follow-up** into a stand-alone question, so "Can we change that later?" retrieves the right passage.
2. **Retrieve and rerank** the excerpts.
3. **Answer:** the model replies in JSON with `answered`, `answer`, and the numbers of the excerpts it used.
4. **Check the citations:** each must be the number of an excerpt the model was actually given. An answer with no valid citation is flagged `uncited`, not shown as sourced.

The prompt is rag-engineering 04's `docs-v1`, which was measured on these documents, with numbered excerpts and citations added (`docs-cited-v1`). The prompts are versioned in [`prompts.json`](src/answer/prompts.json).

Two new question sets were written for this step, and frozen before any answer was generated:
- **20 questions the documents don't answer** ([`not-in-docs.json`](eval/questions/not-in-docs.json)), all near misses, such as a calendar view or a Python client library. Draft questions the documents turned out to answer were dropped.
- **8 two-turn conversations** ([`follow-ups.json`](eval/questions/follow-ups.json)).

Choices were made on the development questions, and the results are reported on the test questions. `npm run eval:answers -- --split test` reproduces them: temperature 0 and a fixed seed give the same 66 replies on every run.

**Results on the test questions**, using `llama3.2:3b` (local), the default retrieval (vector top 10, reranked, 1,000 tokens), numbered citations, and no gate. The replies were labelled by reading each one against the question's reference answer, by Claude (the AI assistant that wrote this code), and haven't yet been reviewed by the repository's owner. The labels, and a note for each reply that isn't correct, are in [`eval/labels/answers-test.json`](eval/labels/answers-test.json), keyed to a hash of the exact reply.

| 48 answerable questions | |
|---|---|
| correct | 31 |
| partly correct (missing a detail the reference has) | 6 |
| wrong | 7 |
| declined | 4 |

| 10 questions the documents don't answer | |
|---|---|
| declined | 7 |
| answered anyway (all three invented) | 3 |

What these results show:

- **The errors are the model's, not retrieval's.** The evidence was in the excerpts for all 48 answerable questions. The wrong answers misread an excerpt that was there: for example, saying the audit log isn't kept after a downgrade when the excerpt says it is.
- **The same comparison as rag-engineering 04.** On its 29 test questions, its pipeline with `docs-v1` got 22 correct, 2 wrong, and 5 declined. This pipeline gets 23 correct, 4 wrong, and 2 declined: it answers more often, and is wrong a little more often.
- **The model doesn't always cite the excerpt it used.** Every citation number was valid, but the cited excerpts contained the evidence for only 27 of the 44 answered questions. Many of the other answers were right but cited a neighbouring excerpt.
  - Asking for **exact quotes instead of numbers** (`CITATIONS=quotes`, prompt `docs-quoted-v1`) makes a citation checkable by construction, because each quote is found in the excerpt it came from. On the development questions it raised cited evidence from 33 to 38 of 50. But it also doubled the invented answers to unanswerable questions, from 2 to 4 of 10, and was slower (median 2.1 s against 1.5 s). The rule fixed before the comparison kept numbers.
- **The relevance gate is off by default.** It declines a question without asking the model when even the best excerpt scores below a threshold. The threshold was tuned on the development questions: the highest that blocks no answerable one.
  - **On the development questions, neither gate caught an unanswerable question the model would have answered.** Every one it blocked, the model declined anyway, which rag-engineering 03 also found.
  - **On the test questions:**
    - the gate on the best reranker score would have caught 2 invented answers, but wrongly blocked 3 answerable questions that were answered correctly or partly;
    - the gate on vector similarity would have caught 1, and blocked nothing it shouldn't.

  `GATE=vector` turns it on.
- **Rewriting follow-ups** retrieved the evidence for 7 of the 8 conversations, against 6 when the follow-up was used as asked. That's too few to show an effect. The one change it made mattered, though: "Can we change that later?" became "Can we change the data region later?", and a confident wrong answer about something else became a decline. The 3B model sometimes left a follow-up unchanged ("And per year?").

An answer took a median of 1.5 s on mains power: an Apple M4 Pro, Ollama 0.40.16, `llama3.2:3b` (`a80c4f17acd5`), recorded on 2026-11-17. A larger model, such as OpenAI's or Claude through `LLM_PROVIDER`, may misread less often. That hasn't been measured here yet.

## PDF documents, measured

[`src/text/pdf.js`](src/text/pdf.js) extracts a PDF's text with [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, Apache-2.0). It rebuilds the text as Markdown, so the structure-aware chunker works the same way on it:
- **Headings:** a line set at least 15% larger than the body text becomes a heading, with levels assigned by size.
- **Paragraphs:** lines that wrapped inside a paragraph are joined back into one.
- **Tables:** they're rebuilt cell by cell.

A PDF with no text, such as a scan, is refused with a reason rather than stored empty.

[`eval/pdf/`](eval/pdf/) holds the five evaluation documents as PDFs. They were rendered from the Markdown and printed to A4 by Google Chrome ([`scripts/make-eval-pdfs.js`](scripts/make-eval-pdfs.js)). `npm run eval:pdf` compares them with the Markdown originals. Text is compared with Markdown symbols, spacing and case ignored on both sides, so a table row read from the PDF ("Annual price | $100 | $250") matches its Markdown source. On the Markdown, this gives exactly the published numbers.

| | Markdown | PDF |
|---|---|---|
| evidence passages present in the extracted text | 170 of 170 | **170 of 170** |
| headings | 121 | **121** (all recovered, at the right levels) |
| chunks / tokens | 98 / 10,913 | 98 / 10,691 |
| test questions found, vector top 10 → reranker (500 / 1,000 / 2,000 tokens) | 45 / 48 / 48 | **46 / 48 / 48** |
| test questions found, RRF (500 / 1,000 / 2,000 tokens) | 45 / 47 / 47 | **45 / 47 / 47** |

**Tables were the hard part.** In a PDF, a table cell that wraps onto a second line is drawn as two separate pieces of text. Joining each visual line from left to right mixes up the cells: "The response wasn't signed with an Add the identity provider's current active certificate certificate (section 4.4)".
- **What that cost:** the first version of the extractor did exactly this, and lost 5 of the 170 evidence passages. It found 44, 46 and 46 test questions instead of 46, 48 and 48.
- **How it's fixed now:** a gap wider than about half the font size separates two columns, while a word space is about a quarter. Pieces of one row that start at the same position belong to one cell, and each cell is read top to bottom.
- **A detail that mattered:** PDF.js adds whitespace-only pieces that span the gap between cells. Those are ignored when measuring gaps, and otherwise no gap would be seen at all.

**What these PDFs don't cover.** They're clean, digitally made PDFs: one column, real text, consistent fonts. Real PDFs can be harder, with scans (no text at all), two-column layouts, text drawn as images, headers and footers repeated on every page, or tables without borders. Those aren't measured here.

## Configuration

Settings come from environment variables or a `.env` file. See [`.env.example`](.env.example), which has OpenAI and Claude examples. Claude is used for answers only, because Anthropic has no embeddings API.

## Evaluation data

[`eval/`](eval/) holds rag-engineering's corpus (five fictional product documents) and its frozen question sets, copied from that repository at commit `d569efa` (MIT, same author):
- `chunking.json`: 60 questions;
- `hybrid-search.json`: 40 questions, also used for reranking.

Every question names the passages that answer it, which is how retrieval is scored.

## Licence

[MIT](LICENSE).

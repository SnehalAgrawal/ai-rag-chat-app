# AI RAG Chat App

Chat with your documents: answers that cite the passages they came from, built on what [rag-engineering](https://github.com/SnehalAgrawal/rag-engineering) measured about chunking, hybrid search, and reranking. It runs locally with **no accounts and no API keys**, and OpenAI or Claude are a setting away.

> **Status: being rebuilt.** This branch replaces the 2025 app (Next.js, Express, Weaviate, one PDF at a time, no citations), which is still on `main`. The plan, in order:
>
> 1. **Foundation** (done): the chunker, document storage, ingest, and the model providers, with tests.
> 2. **Retrieval** (done): vector and keyword search fused with RRF, matching rag-engineering's published numbers exactly.
> 3. **Reranking** (done): a cross-encoder, measured against no reranking and against an LLM judge (whose published numbers are reproduced exactly).
> 4. Answers with checked citations, a relevance gate, and follow-up questions.
> 5. PDF documents.
> 6. The web app.
> 7. Measurements and the README.

## What works now

- **Chunking** ([`src/text/chunker.js`](src/text/chunker.js)): structure-aware chunks with the headings above each chunk copied in. This was the strategy that won rag-engineering's chunking comparison: 29 of 29 test questions at a 1,000-token budget. It's ported from there, and a test checks it makes exactly the same 98 chunks (10,913 tokens) on the same documents.
- **Storage** ([`src/store/store.js`](src/store/store.js)): documents, chunks, and embeddings in one SQLite file, using Node's built-in `node:sqlite`, so nothing native needs installing.
  - Documents are content-hashed: adding the same text again changes nothing, and changed text replaces the old chunks.
  - Each embedding is stored with the name of the model that made it.
  - Ids are never reused, so a citation can't silently point at different text after a document changes.
- **Ingest:** `npm run ingest -- --collection docs path/to/*.md` (Markdown and text for now).
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

## Configuration

Settings come from environment variables or a `.env` file. See [`.env.example`](.env.example), which has OpenAI and Claude examples. Claude is used for answers only, because Anthropic has no embeddings API.

## Evaluation data

[`eval/`](eval/) holds rag-engineering's corpus (five fictional product documents) and its frozen question sets, copied from that repository at commit `d569efa` (MIT, same author):
- `chunking.json`: 60 questions;
- `hybrid-search.json`: 40 questions, also used for reranking.

Every question names the passages that answer it, which is how retrieval is scored.

## Licence

[MIT](LICENSE).

# AI RAG Chat App

Chat with your documents: answers that cite the passages they came from, built on what [rag-engineering](https://github.com/SnehalAgrawal/rag-engineering) measured about chunking, hybrid search, and reranking. It runs locally with **no accounts and no API keys**, and OpenAI or Claude are a setting away.

> **Status: being rebuilt.** This branch replaces the 2025 app (Next.js, Express, Weaviate, one PDF at a time, no citations), which is still on `main`. The plan, in order:
>
> 1. **Foundation** (done): the chunker, document storage, ingest, and the model providers, with tests.
> 2. **Retrieval** (done): vector and keyword search fused with RRF, matching rag-engineering's published numbers exactly.
> 3. Reranking: a cross-encoder, measured against an LLM judge.
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
- **Model providers** ([`src/providers/`](src/providers/)): answers from Ollama, OpenAI (or any OpenAI-compatible API), or Claude; embeddings from Ollama or OpenAI.
  - Ollama embeddings run with `truncate: false`. By default Ollama silently cuts input longer than the model's context, which in rag-engineering's chunking measurements left the evidence for 9 questions unembedded. Here an over-long input is an error instead.
  - `nomic-embed-text` gets its `search_document:` and `search_query:` prefixes added automatically.

## Run it

Requires Node.js 24 or newer, and [Ollama](https://ollama.com):

```bash
ollama pull nomic-embed-text
npm install
npm run ingest -- --collection eval eval/documents/*.md
npm run check            # lint and tests; no network needed
npm run eval:retrieval   # retrieval on the frozen questions, against the published numbers
```

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

## Configuration

Settings come from environment variables or a `.env` file. See [`.env.example`](.env.example), which has OpenAI and Claude examples. Claude is used for answers only, because Anthropic has no embeddings API.

## Evaluation data

[`eval/`](eval/) holds rag-engineering's corpus (five fictional product documents) and its frozen question sets, copied from that repository at commit `d569efa` (MIT, same author):
- `chunking.json`: 60 questions;
- `hybrid-search.json`: 40 questions, also used for reranking.

Every question names the passages that answer it, which is how retrieval is scored.

## Licence

[MIT](LICENSE).

// Adds documents to a collection.
//
//   npm run ingest -- eval/documents/*.md                 (collection "default")
//   npm run ingest -- --collection handbook docs/*.md
//   npm run ingest -- --list

import { parseArgs } from "node:util";
import { ingest, readDocument } from "../src/ingest.js";
import { Store } from "../src/store/store.js";
import { loadTokenizer } from "../src/text/tokens.js";

const { values: args, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    collection: { type: "string", default: "default" },
    db: { type: "string", default: process.env.DATABASE_PATH || "data/app.db" },
    list: { type: "boolean", default: false },
  },
});

const store = new Store(args.db);
try {
  await main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}

async function main() {
  if (args.list || files.length === 0) {
    const collections = store.collections();
    if (!collections.length) console.log(`No documents yet. Add some: npm run ingest -- <files>`);
    for (const c of collections) console.log(`${c.name}: ${c.documents} documents, ${c.chunks} chunks`);
  } else {
    const tokenizer = loadTokenizer();
    if (!tokenizer.exact) console.log("Token counts are estimated (no models/tokenizer.json); chunks will differ slightly from the measured ones.");
    const documents = await Promise.all(files.map(readDocument));
    const results = ingest(store, args.collection, documents, tokenizer);
    for (const [outcome, names] of Object.entries(results)) {
      if (names.length) console.log(`${outcome}: ${names.join(", ")}`);
    }
    const summary = store.collections().find((c) => c.name === args.collection);
    console.log(`Collection "${args.collection}": ${summary.documents} documents, ${summary.chunks} chunks (${args.db})`);
  }
}

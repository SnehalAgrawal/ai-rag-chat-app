// Documents, chunks, and their embeddings in one SQLite file (Node's built-in node:sqlite,
// so there is no native dependency to build).
//
// A document is identified by its collection and name and stored with a SHA-256 of its
// text: ingesting the same text again changes nothing, and changed text replaces the
// document's chunks. Embeddings are stored per chunk with the name of the model that made
// them, so vectors from two different models are never compared.
//
// Ids are never reused (AUTOINCREMENT): without it SQLite hands a deleted chunk's id to the
// next new chunk, and a citation or cached result pointing at that id would silently show
// different text after a document changed.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    text TEXT NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE (collection_id, name)
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    prefix TEXT NOT NULL,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    UNIQUE (document_id, ordinal)
  );
`;

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class Store {
  /** @param {string} path  a file path, or ":memory:" */
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get();
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this app (${SCHEMA_VERSION})`);
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close() {
    this.db.close();
  }

  /** Runs `fn` in one transaction: all of it is stored, or none of it. */
  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  collection(name) {
    const existing = this.db.prepare("SELECT id, name FROM collections WHERE name = ?").get(name);
    if (existing) return existing;
    const { lastInsertRowid } = this.db.prepare("INSERT INTO collections (name, created_at) VALUES (?, ?)").run(name, now());
    return { id: Number(lastInsertRowid), name };
  }

  collections() {
    return this.db
      .prepare(
        `SELECT c.name, COUNT(DISTINCT d.id) AS documents, COUNT(k.id) AS chunks
         FROM collections c LEFT JOIN documents d ON d.collection_id = c.id LEFT JOIN chunks k ON k.document_id = d.id
         GROUP BY c.id ORDER BY c.name`,
      )
      .all();
  }

  document(collectionName, name) {
    return this.db
      .prepare("SELECT d.* FROM documents d JOIN collections c ON c.id = d.collection_id WHERE c.name = ? AND d.name = ?")
      .get(collectionName, name);
  }

  documents(collectionName) {
    return this.db
      .prepare(
        `SELECT d.id, d.name, d.sha256, d.added_at, LENGTH(d.text) AS characters, COUNT(k.id) AS chunks
         FROM documents d JOIN collections c ON c.id = d.collection_id LEFT JOIN chunks k ON k.document_id = d.id
         WHERE c.name = ? GROUP BY d.id ORDER BY d.name`,
      )
      .all(collectionName);
  }

  /**
   * Adds or replaces a document and its chunks.
   * @returns {"added" | "updated" | "unchanged"}
   */
  putDocument(collectionName, name, text, makeChunks) {
    return this.transaction(() => {
      const collection = this.collection(collectionName);
      const hash = sha256(text);
      const existing = this.db.prepare("SELECT id, sha256 FROM documents WHERE collection_id = ? AND name = ?").get(collection.id, name);
      if (existing?.sha256 === hash) return "unchanged";
      let documentId;
      if (existing) {
        this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(existing.id);
        this.db.prepare("UPDATE documents SET sha256 = ?, text = ?, added_at = ? WHERE id = ?").run(hash, text, now(), existing.id);
        documentId = existing.id;
      } else {
        const { lastInsertRowid } = this.db
          .prepare("INSERT INTO documents (collection_id, name, sha256, text, added_at) VALUES (?, ?, ?, ?, ?)")
          .run(collection.id, name, hash, text, now());
        documentId = Number(lastInsertRowid);
      }
      const insert = this.db.prepare(
        "INSERT INTO chunks (document_id, ordinal, label, start, end, prefix, text, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of makeChunks(text)) insert.run(documentId, c.ordinal, c.id, c.start, c.end, c.prefix, c.text, c.tokens);
      return existing ? "updated" : "added";
    });
  }

  deleteDocument(collectionName, name) {
    const document = this.document(collectionName, name);
    if (!document) return false;
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(document.id);
    return true;
  }

  /** Every chunk of a collection, in document and chunk order, with its embedding if it has one. */
  chunks(collectionName) {
    return this.db
      .prepare(
        `SELECT k.id, k.label, d.name AS document, k.ordinal, k.start, k.end, k.prefix, k.text, k.tokens, k.embedding, k.embedding_model
         FROM chunks k JOIN documents d ON d.id = k.document_id JOIN collections c ON c.id = d.collection_id
         WHERE c.name = ? ORDER BY d.name, k.ordinal`,
      )
      .all(collectionName)
      .map(({ embedding, embedding_model: model, ...chunk }) => ({ ...chunk, embedding: embedding ? toVector(embedding) : null, embeddingModel: model }));
  }

  /** Stores embeddings for chunks by chunk id. */
  setEmbeddings(model, entries) {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?");
      for (const { id, vector } of entries) update.run(toBlob(vector), model, id);
    });
  }
}

function now() {
  return new Date().toISOString();
}

function toBlob(vector) {
  const array = Float32Array.from(vector);
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function toVector(blob) {
  // Copy: the bytes SQLite returns may not be aligned for a Float32Array view.
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

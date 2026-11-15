const { OpenAI } = require('openai');

// One client for embeddings and chat. The SDK reads OPENAI_API_KEY and, if set,
// OPENAI_BASE_URL, so any OpenAI-compatible server (for example Ollama) works too.
const openai = new OpenAI();

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.CHAT_MODEL;

if (!CHAT_MODEL) {
  throw new Error('CHAT_MODEL is not set. Copy .env.example to .env and choose a chat model.');
}

module.exports = { openai, EMBEDDING_MODEL, CHAT_MODEL };

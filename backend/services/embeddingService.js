const { openai, EMBEDDING_MODEL } = require('./openaiClient');

async function embedTextChunks(chunks, batchSize = 100) {
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const data of response.data) {
      embeddings.push(data.embedding);
    }
  }
  return embeddings;
}

async function embedQuery(query) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: [query],
  });
  return response.data[0].embedding;
}

module.exports = {
  embedTextChunks,
  embedQuery,
};

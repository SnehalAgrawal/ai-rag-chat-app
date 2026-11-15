const express = require('express');
const { openai, CHAT_MODEL } = require('../services/openaiClient');
const embeddingService = require('../services/embeddingService');
const weaviateService = require('../services/weaviateService');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Nothing to search until the first PDF has been uploaded
    if (!(await weaviateService.hasCollection())) {
      return res.status(409).json({ error: 'No documents indexed yet. Upload a PDF first.' });
    }

    // Embed the question
    const queryEmbedding = await embeddingService.embedQuery(question);

    // Retrieve relevant chunks
    const results = await weaviateService.query({ vector: queryEmbedding }, 3);
    const context = results.map(r => r.chunk).join('\n---\n');

    // Construct prompt
    const prompt = `You are an AI assistant. Use the following context to answer the question. If you don't know, admit it.\n\nContext:\n${context}\n\nQuestion: ${question}`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ],
    });

    const answer = completion.choices[0].message.content.trim();
    res.json({ answer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
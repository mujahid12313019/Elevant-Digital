import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";

const CACHE_TTL_MS = 1000 * 60 * 15;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function buildPrompt(contexts, question) {
  const prompt = `Answer the question using only the provided context. If the context is insufficient, respond with \"I don't know.\"\n\nCONTEXT:\n${contexts}\n\nQUESTION:\n${question}`;
  return prompt.length > 3500 ? prompt.slice(prompt.length - 3500) : prompt;
}

export async function askQuestion(question) {
  const book = await detectBook(question);

  const queryVector = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: question,
  });

  const vector = queryVector.embeddings[0].values;

  // search filter
  const filter = book
    ? {
        must: [
          {
            key: "bookName",
            match: { value: book },
          },
        ],
      }
    : undefined;

  const searchRes = await qdrant.post("/collections/books/points/search", {
    vector,
    limit: 5,
    filter,
    with_payload: true
  });
console.log(JSON.stringify(searchRes.data, null, 2));
  const results = Array.isArray(searchRes?.data?.result)
    ? searchRes.data.result
    : [];

  const contexts = results
    .map((r) => r?.payload?.text ?? "")
    .filter(Boolean)
    .join("\n\n");

  const final = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
Answer using context only:

CONTEXT:
${contexts}

QUESTION:
${question}
`,
  });

  return {
    question,
    bookDetected: book,
    answer: final.text,
  };
}
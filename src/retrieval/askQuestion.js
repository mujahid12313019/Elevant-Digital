import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";
import { detectBook } from "./detectBook.js";

// Response cache with TTL
const CACHE_TTL_MS = 1000 * 60 * 15;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

function getCacheKey(question) {
  return `q:${question.toLowerCase().trim()}`;
}

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
  // LRU eviction
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

export async function askQuestion(question) {
  if (!question || typeof question !== "string") {
    throw new Error("Invalid question: must be a non-empty string");
  }

  const cacheKey = getCacheKey(question);
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("[CACHE HIT]");
    return cached;
  }

  try {
    const book = await detectBook(question);

    const queryVector = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: question,
    });

    const vector = queryVector.embeddings[0].values;

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
      with_payload: true,
    });

    const results = Array.isArray(searchRes?.data?.result) ? searchRes.data.result : [];

    if (results.length === 0) {
      const emptyResult = {
        question,
        bookDetected: book,
        answer: "I don't have relevant information to answer this question.",
      };
      setCache(cacheKey, emptyResult);
      return emptyResult;
    }

    const contexts = results
      .map((r) => r?.payload?.text ?? "")
      .filter(Boolean)
      .join("\n\n");

    const final = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Answer using only the provided context. If insufficient, say "I don't know."\n\nCONTEXT:\n${contexts}\n\nQUESTION:\n${question}`,
    });

    const result = {
      question,
      bookDetected: book,
      answer: final.text,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("askQuestion error:", err.message);
    throw err;
  }
}
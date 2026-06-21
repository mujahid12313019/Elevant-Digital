import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";
import { detectBook } from "./detectBook.js";

// ============================================================================
// FALLBACK MECHANISM CONFIGURATION
// ============================================================================
// Similarity threshold: scores >= 0.7 trigger RAG mode, < 0.7 trigger FALLBACK
const SIMILARITY_THRESHOLD = 0.7;
const MIN_RELEVANT_CHUNKS = 1;

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

/**
 * ============================================================================
 * FALLBACK MODE: Gemini General Knowledge Handler
 * ============================================================================
 * When no relevant chunks found or similarity score is below threshold,
 * use Gemini's general knowledge to answer the user's question naturally.
 * 
 * This function is called in: FALLBACK scenario
 */
async function askGeminiFallback(question, bookDetected) {
  // FALLBACK LOGIC: Use Gemini's general knowledge without RAG context
  // This allows the bot to still provide helpful answers for questions
  // that are either unrelated to the database or have low similarity scores
  
  const fallbackPrompt = `You are a helpful, knowledgeable assistant. Answer the user's question naturally and thoroughly.
Be conversational and provide complete, useful information.
If the question is general knowledge, use your training data to provide accurate information.
${bookDetected ? `Note: The user may have been asking about "${bookDetected}", but no specific information was found. Feel free to provide general context if relevant.` : ""}

QUESTION: ${question}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: fallbackPrompt,
  });

  return response.text;
}

/**
 * ============================================================================
 * RAG MODE: Chunk-based Context Handler
 * ============================================================================
 * When relevant chunks are found and similarity is above threshold,
 * use retrieved chunks as context for Gemini to reason over.
 */
async function askQuestionWithContext(question, contexts) {
  // RAG LOGIC: Ground answer in retrieved chunks
  // Gemini uses both retrieved context and its reasoning to answer
  const ragPrompt = `You are a helpful assistant. Answer the user's question using the provided context.
The context contains relevant information that should inform your answer.
If the context helps answer the question, use it. Be accurate and grounded in the provided information.
Do not contradict information found in the context.

CONTEXT:
${contexts}

QUESTION: ${question}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: ragPrompt,
  });

  return response.text;
}

/**
 * ============================================================================
 * LOGGER: Enhanced Logging for RAG and FALLBACK modes
 * ============================================================================
 * Logs: question, chunk count, similarity score, mode used
 */
function logQueryDetails(question, chunkCount, bestScore, mode, bookDetected) {
  const timestamp = new Date().toISOString();
  const scoreFormatted = bestScore !== null ? bestScore.toFixed(4) : "N/A";
  
  console.log(`
[${timestamp}] ✨ QUERY DETAILS
┌─────────────────────────────────────────────────────────┐
│ Question:           ${question.substring(0, 50)}${question.length > 50 ? "..." : ""}
│ Mode:               ${mode === "RAG" ? "🔍 RAG (Vector Context)" : "🧠 FALLBACK (General Knowledge)"}
│ Chunks Retrieved:   ${chunkCount}
│ Best Similarity:    ${scoreFormatted}
│ Threshold:          ${SIMILARITY_THRESHOLD}
│ Book Detected:      ${bookDetected || "None"}
└─────────────────────────────────────────────────────────┘
  `);
}

export async function askQuestion(question) {
  if (!question || typeof question !== "string") {
    throw new Error("Invalid question: must be a non-empty string");
  }

  const cacheKey = getCacheKey(question);
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("[✓ CACHE HIT]");
    return cached;
  }

  try {
    const book = await detectBook(question);

    // Generate embedding for the user's question
    const queryVector = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: question,
    });

    const vector = queryVector.embeddings[0].values;

    // Build filter if book was detected
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

    // Search vector database
    const searchRes = await qdrant.post("/collections/books/points/search", {
      vector,
      limit: 5,
      filter,
      with_payload: true,
    });

    const results = Array.isArray(searchRes?.data?.result) ? searchRes.data.result : [];

    // ========================================================================
    // FALLBACK MECHANISM - START
    // ========================================================================
    // Check if we have relevant chunks AND if similarity score is above threshold
    
    if (results.length === 0) {
      // NO CHUNKS FOUND → Use FALLBACK mode
      logQueryDetails(question, 0, null, "FALLBACK", book);
      
      const fallbackAnswer = await askGeminiFallback(question, book);
      
      const fallbackResult = {
        question,
        bookDetected: book,
        answer: fallbackAnswer,
        mode: "FALLBACK",
        chunksRetrieved: 0,
        similarityScore: null,
      };
      
      setCache(cacheKey, fallbackResult);
      return fallbackResult;
    }

    // Get the best (highest) similarity score from results
    const bestScore = results[0]?.score ?? 0;
    const retrievedChunks = results.length;

    if (bestScore < SIMILARITY_THRESHOLD) {
      // SIMILARITY SCORE TOO LOW → Use FALLBACK mode
      logQueryDetails(question, retrievedChunks, bestScore, "FALLBACK", book);
      
      const fallbackAnswer = await askGeminiFallback(question, book);
      
      const fallbackResult = {
        question,
        bookDetected: book,
        answer: fallbackAnswer,
        mode: "FALLBACK",
        chunksRetrieved: retrievedChunks,
        similarityScore: bestScore,
      };
      
      setCache(cacheKey, fallbackResult);
      return fallbackResult;
    }

    // ========================================================================
    // RAG MODE - ACTIVATED
    // Score is above threshold → Use retrieved context
    // ========================================================================
    logQueryDetails(question, retrievedChunks, bestScore, "RAG", book);

    const contexts = results
      .map((r) => r?.payload?.text ?? "")
      .filter(Boolean)
      .join("\n\n");

    const ragAnswer = await askQuestionWithContext(question, contexts);

    const ragResult = {
      question,
      bookDetected: book,
      answer: ragAnswer,
      mode: "RAG",
      chunksRetrieved: retrievedChunks,
      similarityScore: bestScore,
    };

    setCache(cacheKey, ragResult);
    return ragResult;
    // ========================================================================
    // FALLBACK MECHANISM - END
    // ========================================================================

  } catch (err) {
    console.error("❌ askQuestion error:", err.message);
    throw err;
  }
}
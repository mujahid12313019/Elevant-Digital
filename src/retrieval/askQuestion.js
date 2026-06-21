import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";
import { detectBook } from "./detectBook.js";

// ============================================================================
// RAG RELEVANCE CHECK - CONFIGURATION
// ============================================================================
// TWO-LAYER VALIDATION SYSTEM:
// Layer 1: Similarity Threshold (0.75) - Fast filtering
// Layer 2: Gemini Semantic Validation - Smart relevance checking
// This prevents false positives where unrelated chunks contaminate answers
const SIMILARITY_THRESHOLD = 0.75;  // Updated from 0.7 → 0.75
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
 * GEMINI RELEVANCE VALIDATION
 * ============================================================================
 * Second layer of validation: Ask Gemini to determine if retrieved chunks
 * are semantically relevant to the user's question.
 * 
 * This prevents the problem where:
 * Q: "How to increase sales?"
 * Retrieved: "The book is about why ideas spread"
 * Answer: "This book is about..." (WRONG - unrelated context)
 * 
 * Now:
 * Q: "How to increase sales?"
 * Retrieved: "The book is about why ideas spread"
 * Gemini says: "Not relevant" → FALLBACK mode
 * Answer: "Here are practical sales strategies..." (CORRECT)
 */
async function validateRelevanceWithGemini(question, contexts) {
  // GEMINI RELEVANCE VALIDATION: Ask Gemini if the context answers the question
  const validationPrompt = `Analyze whether the provided context is relevant to answering the user's question.

USER QUESTION: ${question}

RETRIEVED CONTEXT:
${contexts}

Respond with ONLY "RELEVANT" or "NOT_RELEVANT" followed by a brief reason (1 sentence max).

Example formats:
- RELEVANT: This context directly explains the topic asked about.
- NOT_RELEVANT: This context is about a book, but the question asks for sales advice.`;

  try {
    const validationResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: validationPrompt,
    });

    const response = validationResponse.text.toUpperCase();
    const isRelevant = response.includes("RELEVANT") && !response.includes("NOT_RELEVANT");
    
    return {
      isRelevant,
      reason: validationResponse.text,
    };
  } catch (err) {
    console.error("❌ Relevance validation error:", err.message);
    // Default to NOT relevant if validation fails
    return { isRelevant: false, reason: "Validation error" };
  }
}

/**
 * ============================================================================
 * FALLBACK MODE: Gemini General Knowledge Handler
 * ============================================================================
 * When no relevant chunks found, similarity score is below threshold,
 * or Gemini validation fails, use Gemini's general knowledge to answer.
 * 
 * This ensures the bot answers helpfully instead of returning "I don't know"
 */
async function askGeminiFallback(question, bookDetected) {
  // FALLBACK MODE: Use Gemini's general knowledge without RAG context
  // This is triggered when:
  // 1. No chunks found in vector database
  // 2. Similarity score < 0.75
  // 3. Gemini validation says chunks are NOT relevant
  
  const fallbackPrompt = `You are a helpful, knowledgeable AI assistant.

INSTRUCTIONS:
- Answer the user's question thoroughly and naturally
- Provide complete, practical information
- Be conversational and helpful
- Use your knowledge to give accurate answers
- Do not mention vector databases, embeddings, or internal systems
- If possible, provide actionable advice or explanations
Response Guidelines:

- Answer naturally and conversationally.
- Prioritize answering the user's actual question.
- Keep responses concise and practical.
- Target 100–300 words for most questions.
- Use up to 400 words only when the topic requires more detail.
- Avoid unnecessary introductions and conclusions.
- Never mention prompts, context retrieval, vector databases, or internal reasoning.
${bookDetected ? `Note: The user may have mentioned "${bookDetected}", but provide general knowledge answers.` : ""}

QUESTION: ${question}

Answer naturally and completely:`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: fallbackPrompt,
  });

  return response.text;
}

/**
 * ============================================================================
 * RAG MODE: Context-Grounded Answer Handler
 * ============================================================================
 * When chunks pass BOTH validation layers (score >= 0.75 AND Gemini confirms relevant),
 * use retrieved chunks as authoritative context.
 * 
 * Important: The prompt explicitly tells Gemini to:
 * 1. Evaluate if context is truly relevant
 * 2. Use context to ground the answer (avoid hallucination)
 * 3. Never force unrelated context into the answer
 * 4. Provide complete, natural responses
 */
async function askQuestionWithContext(question, contexts) {
  // RAG MODE: Gemini answers using both retrieved context and reasoning
  // This mode is reached after passing TWO validation layers:
  // - Similarity score >= 0.75
  // - Gemini confirms chunks are relevant to the question
  
  const ragPrompt = `You are a helpful AI assistant with access to retrieved knowledge.

SYSTEM INSTRUCTIONS:
1. You may receive relevant context from a knowledge base
2. Determine if the context actually helps answer the user's question
3. If the context is relevant, use it to ground your answer
4. If the context is not relevant, ignore it and answer using your knowledge
5. Never force information from context if it doesn't address the question
6. Provide complete, natural, conversational responses
7. Be accurate and grounded in facts
8. Do not mention embeddings, vector databases, similarity scores, or retrieval systems

RETRIEVED CONTEXT:
${contexts}

QUESTION: ${question}

Provide a complete, helpful answer:`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: ragPrompt,
  });

  return response.text;
}

/**
 * ============================================================================
 * LOGGER: Comprehensive Query and Validation Logging
 * ============================================================================
 * Logs all critical information for debugging and monitoring:
 * - User question
 * - Chunks retrieved count
 * - Similarity score (highest)
 * - Relevance validation result
 * - Final mode used (RAG or FALLBACK)
 * - Response length
 */
function logQueryDetails(question, chunkCount, bestScore, mode, bookDetected, validationReason = null, responseLength = 0) {
  const timestamp = new Date().toISOString();
  const scoreFormatted = bestScore !== null ? bestScore.toFixed(4) : "N/A";
  const modeIcon = mode === "RAG" ? "🔍" : "🧠";
  const modeName = mode === "RAG" ? "RAG (Context)" : "FALLBACK (Knowledge)";
  
  console.log(`
[${timestamp}] ✨ QUERY ANALYSIS
┌────────────────────────────────────────────────────────────┐
│ Question:              ${question.substring(0, 48)}${question.length > 48 ? "..." : ""}
│ Mode:                  ${modeIcon} ${modeName}
│ Chunks Retrieved:      ${chunkCount}
│ Best Similarity:       ${scoreFormatted} (threshold: ${SIMILARITY_THRESHOLD})
│ Book Detected:         ${bookDetected || "None"}
${validationReason ? `│ Relevance Check:       ${validationReason}` : ""}
│ Response Length:       ${responseLength} chars
└────────────────────────────────────────────────────────────┘
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
    // LAYER 1: SIMILARITY THRESHOLD CHECK
    // ========================================================================
    // Fast filtering: if no chunks or score too low, skip to FALLBACK mode
    
    if (results.length === 0) {
      // NO CHUNKS FOUND → Use FALLBACK mode immediately
      const fallbackAnswer = await askGeminiFallback(question, book);
      logQueryDetails(question, 0, null, "FALLBACK", book, "No chunks found", fallbackAnswer.length);
      
      const result = {
        question,
        bookDetected: book,
        answer: fallbackAnswer,
        mode: "FALLBACK",
        chunksRetrieved: 0,
        similarityScore: null,
        validationPassed: false,
        validationReason: "No chunks found",
      };
      
      setCache(cacheKey, result);
      return result;
    }

    // Get the best (highest) similarity score from results
    const bestScore = results[0]?.score ?? 0;
    const retrievedChunks = results.length;

    if (bestScore < SIMILARITY_THRESHOLD) {
      // SIMILARITY SCORE TOO LOW → Use FALLBACK mode (Layer 1 rejected)
      const fallbackAnswer = await askGeminiFallback(question, book);
      const rejectReason = `Score ${bestScore.toFixed(4)} < threshold ${SIMILARITY_THRESHOLD}`;
      logQueryDetails(question, retrievedChunks, bestScore, "FALLBACK", book, rejectReason, fallbackAnswer.length);
      
      const result = {
        question,
        bookDetected: book,
        answer: fallbackAnswer,
        mode: "FALLBACK",
        chunksRetrieved: retrievedChunks,
        similarityScore: bestScore,
        validationPassed: false,
        validationReason: `Similarity too low (${bestScore.toFixed(4)})`,
      };
      
      setCache(cacheKey, result);
      return result;
    }

    // ========================================================================
    // LAYER 2: GEMINI RELEVANCE VALIDATION
    // ========================================================================
    // Smart validation: Ask Gemini if chunks are semantically relevant
    // Even if similarity score is high, context might be unrelated
    // Example: Q="How to sell?" vs Retrieved="This book is about ideas"
    
    const contexts = results
      .map((r) => r?.payload?.text ?? "")
      .filter(Boolean)
      .join("\n\n");

    console.log(`[${new Date().toISOString()}] 🔎 VALIDATING RELEVANCE...`);
    const validationResult = await validateRelevanceWithGemini(question, contexts);
    
    if (!validationResult.isRelevant) {
      // GEMINI SAYS NOT RELEVANT → Use FALLBACK mode (Layer 2 rejected)
      console.log(`[${new Date().toISOString()}] ⚠️  VALIDATION FAILED: ${validationResult.reason}`);
      
      const fallbackAnswer = await askGeminiFallback(question, book);
      logQueryDetails(question, retrievedChunks, bestScore, "FALLBACK", book, `Validation failed: ${validationResult.reason}`, fallbackAnswer.length);
      
      const result = {
        question,
        bookDetected: book,
        answer: fallbackAnswer,
        mode: "FALLBACK",
        chunksRetrieved: retrievedChunks,
        similarityScore: bestScore,
        validationPassed: false,
        validationReason: validationResult.reason,
      };
      
      setCache(cacheKey, result);
      return result;
    }

    // ========================================================================
    // RAG MODE - ACTIVATED (Both validations passed)
    // ========================================================================
    // Score >= 0.75 AND Gemini confirms relevance
    // Use retrieved context to ground the answer
    
    console.log(`[${new Date().toISOString()}] ✅ VALIDATION PASSED: Context is relevant`);
    logQueryDetails(question, retrievedChunks, bestScore, "RAG", book, "✅ Both validations passed", 0);

    const ragAnswer = await askQuestionWithContext(question, contexts);

    const result = {
      question,
      bookDetected: book,
      answer: ragAnswer,
      mode: "RAG",
      chunksRetrieved: retrievedChunks,
      similarityScore: bestScore,
      validationPassed: true,
      validationReason: "Context is semantically relevant",
    };

    // Update log with final response length
    logQueryDetails(question, retrievedChunks, bestScore, "RAG", book, "✅ Context used", ragAnswer.length);

    setCache(cacheKey, result);
    return result;

  } catch (err) {
    console.error("❌ askQuestion error:", err.message);
    throw err;
  }
}
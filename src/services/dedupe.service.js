/**
 * Duplicate Chunk Detector
 * 
 * Prevents re-embedding of duplicate chunks using multiple strategies:
 * 1. Content-based hashing (MD5)
 * 2. Qdrant vector search for semantic duplicates
 * 3. Progress tracking to skip already-embedded chunks
 * 
 * Why this prevents 429 errors:
 * - Avoids redundant API calls for duplicate content
 * - Reduces total embedding requests significantly
 * - Faster ingestion = less quota consumed
 */

import crypto from "crypto";
import { qdrant } from "../config/qdrant.js";

/**
 * Generate content hash (MD5)
 * Use for exact duplicate detection
 */
export function hashChunk(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

/**
 * Check if chunk was already processed by progress tracking
 */
export function isChunkProcessed(chunkIndex, progress) {
  if (!progress) return false;
  return progress.embeddedChunkIds && progress.embeddedChunkIds.includes(chunkIndex);
}

/**
 * Check if chunk already exists in Qdrant (semantic search)
 * Useful for finding similar content even if not exact duplicate
 */
export async function checkForDuplicateInVectorStore(
  vector,
  bookName,
  threshold = 0.98
) {
  try {
    const searchRes = await qdrant.post(
      "/collections/books/points/search",
      {
        vector,
        limit: 1,
        filter: {
          must: [
            {
              key: "bookName",
              match: { value: bookName },
            },
          ],
        },
        with_payload: true,
        score_threshold: threshold, // Only if similarity > 98%
      }
    );

    const results = Array.isArray(searchRes?.data?.result)
      ? searchRes.data.result
      : [];

    if (results.length > 0) {
      const score = results[0].score;
      return {
        isDuplicate: true,
        similarityScore: score,
        existingChunkIndex: results[0]?.payload?.chunkIndex,
        existingText: results[0]?.payload?.text?.slice(0, 100),
      };
    }

    return { isDuplicate: false };
  } catch (err) {
    console.error("❌ Error checking for duplicates:", err.message);
    // Don't fail ingestion if duplicate check fails
    return { isDuplicate: false, error: err.message };
  }
}

/**
 * Build deduplication report for logging
 */
export function buildDedupeReport(stats) {
  return {
    totalChunks: stats.total,
    processedChunks: stats.processed,
    skippedDuplicates: stats.skipped,
    failedChunks: stats.failed,
    efficiencyPercent: ((stats.skipped / stats.total) * 100).toFixed(1),
    embeddingsSaved: stats.skipped, // Embedding API calls saved
  };
}

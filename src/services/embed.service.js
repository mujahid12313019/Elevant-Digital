/**
 * Embedding Service with Advanced Retry Logic
 * 
 * Handles:
 * - Exponential backoff with jitter for 429 errors
 * - Reading Retry-After headers from Gemini API
 * - Up to 5 retries before failing
 * - Rate limiting integration
 * 
 * Why this prevents 429 errors:
 * - Detects 429 RESOURCE_EXHAUSTED errors immediately
 * - Respects server's Retry-After header if provided
 * - Implements exponential backoff: 2^retry * 1000ms + random(0-1000ms)
 * - Reduces request intensity on subsequent retries
 * - Never hammers the API during quota exhaustion
 */

import { ai } from "../config/gemini.js";
import { rateLimiter } from "./rateLimiter.service.js";

// Configuration from environment
const MAX_RETRIES = parseInt(process.env.EMBED_MAX_RETRIES || "5", 10);
const BASE_RETRY_DELAY_MS = 1000; // Start with 1 second

/**
 * Parse Retry-After header (can be seconds or HTTP-date)
 */
function parseRetryAfter(retryAfterHeader) {
  if (!retryAfterHeader) return null;

  const seconds = parseInt(retryAfterHeader, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000; // Convert to milliseconds
  }

  // Try to parse as HTTP-date
  const date = new Date(retryAfterHeader);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

/**
 * Calculate exponential backoff delay with jitter
 * Formula: (2^retry * BASE_DELAY) + random(0, 1000ms)
 * Prevents thundering herd problem
 */
function calculateBackoffDelay(retryCount) {
  const exponentialDelay = Math.pow(2, retryCount) * BASE_RETRY_DELAY_MS;
  const jitter = Math.random() * 1000; // 0-1000ms random jitter
  return exponentialDelay + jitter;
}

/**
 * Embed a single chunk with advanced retry logic
 * Respects rate limits and handles 429 errors gracefully
 */
export async function embedChunk(text, retryCount = 0) {
  try {
    // Wait for rate limiter before making request
    const waitTime = await rateLimiter.waitForToken();
    if (waitTime > 0) {
      console.log(`⏸️  Rate limit: waited ${waitTime.toFixed(0)}ms`);
    }

    // Make embedding request
    const result = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
    });

    return result.embeddings[0].values;
  } catch (error) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;

    // Handle 429 RESOURCE_EXHAUSTED
    if (status === 429) {
      if (retryCount >= MAX_RETRIES) {
        console.error(
          `❌ [EMBED_FAILED] Max retries (${MAX_RETRIES}) exceeded for 429 error`
        );
        throw new Error(`Embedding failed after ${MAX_RETRIES} retries: ${statusText}`);
      }

      // Get delay from header or calculate exponential backoff
      let delayMs = parseRetryAfter(error.response?.headers["retry-after"]);
      if (!delayMs) {
        delayMs = calculateBackoffDelay(retryCount);
      }

      console.log(
        `⚠️  [429 QUOTA] Attempt ${retryCount + 1}/${MAX_RETRIES}. ` +
        `Waiting ${(delayMs / 1000).toFixed(1)}s before retry...`
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));

      // Recursive retry
      return embedChunk(text, retryCount + 1);
    }

    // Handle other errors
    if (status === 503 || status === 500) {
      if (retryCount >= MAX_RETRIES) {
        console.error(
          `❌ [EMBED_FAILED] Max retries exceeded for ${status} error`
        );
        throw error;
      }

      const delayMs = calculateBackoffDelay(retryCount);
      console.log(
        `⚠️  [${status}] Server error. Retry ${retryCount + 1}/${MAX_RETRIES} ` +
        `in ${(delayMs / 1000).toFixed(1)}s...`
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
      return embedChunk(text, retryCount + 1);
    }

    // Non-retryable errors
    throw error;
  }
}

/**
 * Embed multiple chunks with batching and retry logic
 * Processes in configurable batch sizes with progress tracking
 */
export async function embedBatch(chunks, onProgress = null) {
  const batchSize = parseInt(process.env.EMBED_BATCH_SIZE || "10", 10);
  const results = [];
  const failed = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(chunks.length / batchSize);

    console.log(
      `📦 [BATCH ${batchNum}/${totalBatches}] Processing ${batch.length} chunks...`
    );

    for (let j = 0; j < batch.length; j++) {
      try {
        const vector = await embedChunk(batch[j]);
        results.push(vector);

        const processedCount = i + j + 1;
        const progressPercent = Math.round((processedCount / chunks.length) * 100);

        if (onProgress) {
          onProgress({
            processed: processedCount,
            total: chunks.length,
            percent: progressPercent,
            batch: batchNum,
            totalBatches,
          });
        }
      } catch (err) {
        console.error(
          `❌ Failed to embed chunk ${i + j} after retries: ${err.message}`
        );
        failed.push({ index: i + j, error: err.message, text: batch[j] });
        results.push(null); // Placeholder for failed chunk
      }
    }
  }

  return { vectors: results, failed };
}

/**
 * Get rate limiter stats
 */
export function getRateLimiterStats() {
  return rateLimiter.getStats();
}

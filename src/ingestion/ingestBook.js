/**
 * PRODUCTION-GRADE BOOK INGESTION PIPELINE
 * 
 * Features:
 * ✓ Rate limit handling (80 req/min, configurable)
 * ✓ Exponential backoff with jitter for 429 errors
 * ✓ Up to 5 automatic retries
 * ✓ Batch processing (configurable batch size)
 * ✓ Duplicate detection (progress tracking + semantic)
 * ✓ Resumable ingestion (MongoDB progress tracking)
 * ✓ Structured logging with detailed metrics
 * ✓ Memory-efficient processing
 * ✓ Graceful error handling (won't crash server)
 * 
 * Environment Variables:
 * - EMBED_BATCH_SIZE: Chunks per batch (default: 10)
 * - EMBED_DELAY_MS: Delay between requests (default: auto via rate limiter)
 * - EMBED_MAX_RETRIES: Max retries on 429 (default: 5)
 * - EMBED_REQUESTS_PER_MINUTE: Rate limit quota (default: 80)
 * - MONGODB_URI: MongoDB connection string (for resumable ingestion)
 */

import { chunkText } from "./chunkText.js";
import { extractTitle } from "./extractTitle.js";
import { qdrant } from "../config/qdrant.js";
import { updateProgress, updateStatus, setJobResult } from "./jobManager.js";

// New services for production ingestion
import { embedChunk, embedBatch, getRateLimiterStats } from "../services/embed.service.js";
import {
  getOrCreateProgress,
  updateProgress as updateDbProgress,
  completeProgress,
  failProgress,
  initProgress,
} from "../services/progress.service.js";
import { isChunkProcessed, checkForDuplicateInVectorStore, hashChunk, buildDedupeReport } from "../services/dedupe.service.js";
import { IngestionLogger } from "../utils/logger.js";

// Initialize MongoDB on module load
let progressDb = null;
(async () => {
  progressDb = await initProgress();
})();

/**
 * LEGACY: Backward compatible synchronous ingestion
 * Note: This is slower and not recommended for large books
 * Use ingestBookBackground instead
 */
export async function ingestBook(text) {
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Invalid text: must be non-empty string");
  }

  const bookName = await extractTitle(text);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    throw new Error("No chunks extracted from text");
  }

  let embeddedCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embedChunk(chunks[i]);

    await qdrant.put("/collections/books/points", {
      points: [
        {
          id: Date.now() + i,
          vector,
          payload: {
            bookName,
            chunkIndex: i,
            text: chunks[i],
          },
        },
      ],
    });

    embeddedCount++;
  }

  return {
    bookName,
    chunksStored: embeddedCount,
  };
}

/**
 * PRODUCTION: High-performance background ingestion
 * 
 * Key features:
 * 1. Rate limiting: Spreads requests over time
 * 2. Batch processing: Groups embeddings efficiently
 * 3. Duplicate detection: Skips already-embedded content
 * 4. Resumable: Stores progress in MongoDB
 * 5. Detailed logging: Comprehensive metrics
 */
export async function ingestBookBackground(jobId, text, opts = {}) {
  let logger = null;
  let progress = null;

  try {
    // ============================================================
    // SETUP PHASE: Validate input, extract metadata, chunk text
    // ============================================================

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Invalid text: must be non-empty string");
    }

    const bookName = await extractTitle(text);
    const chunks = chunkText(text);
    const total = chunks.length;

    if (total === 0) {
      throw new Error("No chunks extracted from text");
    }

    // Initialize logger and progress tracking
    logger = new IngestionLogger(jobId);
    logger.logJobStart(bookName, total);

    // Check if we're resuming
    progress = await getOrCreateProgress(jobId, bookName, total);
    if (!progress) {
      console.warn("⚠️  Progress tracking unavailable. Ingestion won't be resumable.");
    }

    updateStatus(jobId, "processing");

    // ============================================================
    // PROCESSING PHASE: Embed chunks with rate limiting & retries
    // ============================================================

    const BATCH_SIZE = opts.batchSize || parseInt(process.env.EMBED_BATCH_SIZE || "10", 10);
    let idCounter = Date.now();
    let embeddedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const failedChunks = [];

    for (let batchStart = 0; batchStart < total; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, total);
      const batchChunks = chunks.slice(batchStart, batchEnd);
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(total / BATCH_SIZE);

      logger.logBatchStart(batchNum, totalBatches, batchChunks.length);

      // Separate already-processed chunks from new ones
      const newChunks = [];
      const newIndices = [];
      const skippedIndices = [];

      for (let i = 0; i < batchChunks.length; i++) {
        const globalIndex = batchStart + i;

        // Skip if already processed (resumable ingestion)
        if (isChunkProcessed(globalIndex, progress)) {
          logger.logDuplicateSkipped(globalIndex, "Already processed (resuming)");
          skippedCount++;
          skippedIndices.push(globalIndex);
          continue;
        }

        newChunks.push(batchChunks[i]);
        newIndices.push(globalIndex);
      }

      // If all chunks in batch were skipped, continue
      if (newChunks.length === 0) {
        console.log(`  ⊘ Batch ${batchNum}: All ${batchChunks.length} chunks skipped (resuming)`);
        continue;
      }

      // ========================================================
      // EMBEDDING PHASE: Call Gemini API with rate limiting
      // ========================================================

      const { vectors, failed } = await embedBatch(newChunks, (progress_info) => {
        logger.logChunkProgress(
          batchStart + progress_info.processed,
          total,
          "processing"
        );
        logger.logJobProgress(
          embeddedCount + progress_info.processed,
          total,
          progress_info.batch,
          progress_info.totalBatches
        );

        // Update job progress
        updateProgress(jobId, Math.round(progress_info.percent));
      });

      // ========================================================
      // DEDUPLICATION PHASE: Check for semantic duplicates
      // ========================================================

      let vectorsToStore = [];
      let indicesToStore = [];

      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i] === null) {
          // Embedding failed
          failedCount++;
          failedChunks.push({
            index: newIndices[i],
            text: newChunks[i],
            error: failed.find((f) => f.index === i)?.error,
          });
          continue;
        }

        // Check for semantic duplicates in vector store
        const dupCheck = await checkForDuplicateInVectorStore(vectors[i], bookName);
        if (dupCheck.isDuplicate) {
          logger.logDuplicateSkipped(
            newIndices[i],
            `Semantic duplicate (${(dupCheck.similarityScore * 100).toFixed(1)}% match)`
          );
          skippedCount++;

          if (progressDb) {
            await updateDbProgress(jobId, newIndices[i], "skipped");
          }
          continue;
        }

        vectorsToStore.push(vectors[i]);
        indicesToStore.push(i);
      }

      // ========================================================
      // STORAGE PHASE: Insert into Qdrant vector database
      // ========================================================

      if (vectorsToStore.length > 0) {
        const points = vectorsToStore.map((vector, i) => ({
          id: ++idCounter,
          vector,
          payload: {
            bookName,
            chunkIndex: newIndices[indicesToStore[i]],
            chunkHash: hashChunk(newChunks[indicesToStore[i]]),
            text: newChunks[indicesToStore[i]],
            embeddedAt: new Date().toISOString(),
          },
        }));

        try {
          await qdrant.put("/collections/books/points", { points });
          embeddedCount += points.length;

          // Update MongoDB progress
          if (progressDb) {
            for (const idx of indicesToStore) {
              await updateDbProgress(jobId, newIndices[idx], "success");
            }
          }

          console.log(`  ✓ Stored ${points.length} vectors in Qdrant`);
        } catch (err) {
          if (err.response?.status === 404) {
            throw new Error(
              "Collection 'books' not found. Run 'node embedding.js' first to create it."
            );
          }
          throw err;
        }
      }

      // Update job status
      const totalProcessed = embeddedCount + skippedCount;
      const percent = Math.round((totalProcessed / total) * 100);
      updateProgress(jobId, percent);
    }

    // ============================================================
    // COMPLETION PHASE: Finalize and report metrics
    // ============================================================

    const result = {
      bookName,
      totalChunks: total,
      embeddedChunks: embeddedCount,
      skippedChunks,
      failedChunks,
      apiEfficiency: (
        ((total - skippedCount) / total) *
        100
      ).toFixed(1),
      rateLimiterStats: getRateLimiterStats(),
    };

    // Mark job complete
    if (progressDb) {
      await completeProgress(jobId, result);
    }

    setJobResult(jobId, result);
    updateProgress(jobId, 100);
    updateStatus(jobId, "completed");

    logger.logJobComplete();
    console.log("📊 Final Report:", JSON.stringify(buildDedupeReport({
      total,
      processed: embeddedCount,
      skipped: skippedCount,
      failed: failedCount,
    }), null, 2));

    if (failedChunks.length > 0) {
      console.warn("⚠️  Failed chunks:", failedChunks.slice(0, 5)); // Show first 5
    }

    return result;
  } catch (err) {
    console.error("❌ Ingestion failed:", err.message);

    if (logger) {
      logger.logJobFailed(err);
    }

    if (progressDb) {
      await failProgress(jobId, err);
    }

    updateStatus(jobId, "failed", err?.message || String(err));
    throw err;
  }
}

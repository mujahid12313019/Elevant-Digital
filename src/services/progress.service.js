/**
 * MongoDB Progress Tracker
 * 
 * Enables resumable ingestion by storing progress in MongoDB
 * 
 * Why this prevents 429 errors:
 * - Allows resuming from last successful chunk instead of restarting
 * - Avoids re-embedding same chunks if process crashes
 * - Enables checkpoint-based recovery
 * 
 * Setup: Add MONGODB_URI to .env
 * Example: mongodb+srv://user:pass@cluster.mongodb.net/database
 */

import dotenv from "dotenv";
dotenv.config();

let mongoClient = null;
let progressCollection = null;

/**
 * Initialize MongoDB connection
 */
export async function initProgress() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn("⚠️  MONGODB_URI not set. Progress tracking disabled.");
    return null;
  }

  try {
    // Lazy import to avoid dependency if not used
    const { MongoClient } = await import("mongodb");
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();

    const db = mongoClient.db(process.env.MONGODB_DB_NAME || "rag_system");
    progressCollection = db.collection("ingest_progress");

    // Create index for fast lookups
    await progressCollection.createIndex({ jobId: 1 }, { unique: true });
    await progressCollection.createIndex({ bookName: 1 });

    console.log("✓ MongoDB connected for progress tracking");
    return progressCollection;
  } catch (err) {
    console.error("❌ Failed to connect MongoDB:", err.message);
    console.warn("⚠️  Continuing without progress persistence...");
    return null;
  }
}

/**
 * Create or get progress record
 */
export async function getOrCreateProgress(jobId, bookName, totalChunks) {
  if (!progressCollection) return null;

  try {
    const existing = await progressCollection.findOne({ jobId });
    if (existing) {
      console.log(
        `📖 Resuming job ${jobId}: ${existing.processedChunks}/${totalChunks} chunks done`
      );
      return existing;
    }

    const newProgress = {
      jobId,
      bookName,
      totalChunks,
      processedChunks: 0,
      skippedChunks: 0,
      failedChunks: 0,
      failedIndices: [],
      embeddedChunkIds: [], // Track which chunks were embedded
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "in-progress",
    };

    await progressCollection.insertOne(newProgress);
    console.log(`📝 Created new progress record for job ${jobId}`);
    return newProgress;
  } catch (err) {
    console.error("❌ Error accessing progress:", err.message);
    return null;
  }
}

/**
 * Update progress after embedding a chunk
 */
export async function updateProgress(
  jobId,
  chunkIndex,
  status = "success",
  error = null
) {
  if (!progressCollection) return null;

  try {
    const update = {
      $set: { updatedAt: new Date() },
    };

    if (status === "success") {
      update.$inc = { processedChunks: 1 };
      update.$push = { embeddedChunkIds: chunkIndex };
    } else if (status === "skipped") {
      update.$inc = { skippedChunks: 1 };
    } else if (status === "failed") {
      update.$inc = { failedChunks: 1 };
      update.$push = { failedIndices: { index: chunkIndex, error } };
    }

    return await progressCollection.updateOne({ jobId }, update);
  } catch (err) {
    console.error("❌ Error updating progress:", err.message);
    return null;
  }
}

/**
 * Complete ingestion job
 */
export async function completeProgress(jobId, result) {
  if (!progressCollection) return null;

  try {
    return await progressCollection.updateOne(
      { jobId },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          result,
        },
      }
    );
  } catch (err) {
    console.error("❌ Error completing progress:", err.message);
    return null;
  }
}

/**
 * Mark job as failed
 */
export async function failProgress(jobId, error) {
  if (!progressCollection) return null;

  try {
    return await progressCollection.updateOne(
      { jobId },
      {
        $set: {
          status: "failed",
          error: error.message,
          failedAt: new Date(),
        },
      }
    );
  } catch (err) {
    console.error("❌ Error failing progress:", err.message);
    return null;
  }
}

/**
 * Get progress record
 */
export async function getProgress(jobId) {
  if (!progressCollection) return null;

  try {
    return await progressCollection.findOne({ jobId });
  } catch (err) {
    console.error("❌ Error fetching progress:", err.message);
    return null;
  }
}

/**
 * Close MongoDB connection
 */
export async function closeProgress() {
  if (mongoClient) {
    await mongoClient.close();
    console.log("✓ MongoDB connection closed");
  }
}

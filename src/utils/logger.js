/**
 * Structured Logging for Ingestion Pipeline
 * 
 * Provides consistent, detailed logging throughout the ingestion process
 * Tracks metrics needed to optimize quota usage
 */

export class IngestionLogger {
  constructor(jobId) {
    this.jobId = jobId;
    this.startTime = Date.now();
    this.stats = {
      totalChunks: 0,
      processedChunks: 0,
      skippedChunks: 0,
      failedChunks: 0,
      totalRequests: 0,
      totalRetries: 0,
      rate429Errors: 0,
      totalWaitTimeMs: 0,
    };
  }

  logJobStart(bookName, totalChunks) {
    this.stats.totalChunks = totalChunks;
    console.log(`
╔════════════════════════════════════════════════════════════╗
║ 📚 INGESTION STARTED                                       ║
║━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║
║ Job ID:        ${jobId}
║ Book:          ${bookName}
║ Total Chunks:  ${totalChunks}
║ Start Time:    ${new Date().toISOString()}
╚════════════════════════════════════════════════════════════╝
    `);
  }

  logBatchStart(batchNum, totalBatches, chunkCount) {
    console.log(
      `\n📦 [BATCH ${batchNum}/${totalBatches}] Starting ${chunkCount} chunks...`
    );
  }

  logChunkProgress(index, total, status, details = {}) {
    const percent = Math.round((index / total) * 100);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    let icon = "✓";
    if (status === "skipped") {
      icon = "⊘";
      this.stats.skippedChunks++;
    } else if (status === "failed") {
      icon = "✗";
      this.stats.failedChunks++;
    } else if (status === "retry") {
      icon = "↻";
      this.stats.totalRetries++;
    } else {
      this.stats.processedChunks++;
    }

    if (index % 10 === 0) {
      // Log every 10 chunks to avoid spam
      console.log(
        `  ${icon} [${percent}%] ${index}/${total} | ${elapsed}s | ${
          details.reason || ""
        }`
      );
    }
  }

  logQuotaExceeded(retryCount, waitMs) {
    this.stats.rate429Errors++;
    this.stats.totalWaitTimeMs += waitMs;
    console.log(
      `⚠️  [429 QUOTA] Retry #${retryCount} | Waiting ${(waitMs / 1000).toFixed(
        1
      )}s...`
    );
  }

  logDuplicateSkipped(index, reason) {
    this.stats.skippedChunks++;
    console.log(`  ⊘ [SKIP] Chunk ${index}: ${reason}`);
  }

  logJobProgress(processed, total, currentBatch, totalBatches) {
    const percent = Math.round((processed / total) * 100);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const rate = (processed / (elapsed / 60)).toFixed(1);
    const eta = processed > 0 
      ? ((elapsed / processed) * (total - processed) / 60).toFixed(1)
      : "?";

    process.stdout.write(
      `\r⏱️  [${percent}%] ${processed}/${total} | ` +
      `Batch ${currentBatch}/${totalBatches} | ` +
      `${rate} chunks/min | ETA: ${eta}m`
    );
  }

  logJobComplete() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const rate = (this.stats.processedChunks / (elapsed / 60)).toFixed(1);

    console.log(`\n
╔════════════════════════════════════════════════════════════╗
║ ✓ INGESTION COMPLETED                                      ║
║━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║
║ Total Time:        ${elapsed}s
║ Processed:         ${this.stats.processedChunks}/${this.stats.totalChunks}
║ Skipped:           ${this.stats.skippedChunks} (dedup/resume)
║ Failed:            ${this.stats.failedChunks}
║ Rate:              ${rate} chunks/min
║ 429 Errors:        ${this.stats.rate429Errors}
║ Backoff Wait:      ${(this.stats.totalWaitTimeMs / 1000).toFixed(1)}s
║ API Efficiency:    ${((1 - this.stats.skippedChunks / this.stats.totalChunks) * 100).toFixed(1)}%
╚════════════════════════════════════════════════════════════╝
    `);
  }

  logJobFailed(error) {
    console.log(`\n
╔════════════════════════════════════════════════════════════╗
║ ✗ INGESTION FAILED                                         ║
║━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║
║ Error:             ${error.message}
║ Processed:         ${this.stats.processedChunks}/${this.stats.totalChunks}
║ Status:            RESUMABLE - restart to continue from last checkpoint
╚════════════════════════════════════════════════════════════╝
    `);
  }

  getStats() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    return {
      ...this.stats,
      elapsedSeconds: elapsed,
      chunksPerMinute: (this.stats.processedChunks / (elapsed / 60)).toFixed(1),
      apiCallsPerMinute: (this.stats.totalRequests / (elapsed / 60)).toFixed(1),
    };
  }
}

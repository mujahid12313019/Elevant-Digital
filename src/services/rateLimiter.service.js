/**
 * Rate Limiter Service
 * 
 * Implements token bucket algorithm to throttle requests and prevent exceeding Gemini API quotas.
 * Default: 80 requests per minute (safe margin below 100 requests/min limit)
 * 
 * Why this prevents 429 errors:
 * - Spreads requests evenly over time instead of bursting
 * - Maintains a "bucket" of available tokens that refill at a steady rate
 * - Blocks execution if quota exceeded, allowing natural backpressure
 */

class RateLimiter {
  constructor(requestsPerMinute = 80) {
    this.requestsPerMinute = requestsPerMinute;
    this.tokensPerSecond = requestsPerMinute / 60;
    this.maxTokens = requestsPerMinute; // Max bucket size
    this.tokens = this.maxTokens; // Start with full bucket
    this.lastRefillTime = Date.now();
    this.totalRequests = 0;
    this.drainedAt = null;
  }

  /**
   * Get the number of available tokens
   * Refills tokens based on elapsed time since last refill
   */
  getAvailableTokens() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    
    // Add tokens based on elapsed time
    const tokensToAdd = elapsedSeconds * this.tokensPerSecond;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
    
    return Math.floor(this.tokens);
  }

  /**
   * Wait until a token is available
   * Implements exponential backoff-like behavior by waiting for refill
   * Returns the delay in milliseconds that was waited
   */
  async waitForToken() {
    const available = this.getAvailableTokens();
    
    if (available > 0) {
      this.tokens -= 1;
      this.totalRequests++;
      return 0; // No wait needed
    }

    // Calculate wait time: time for 1 token to refill
    const waitMs = (1 / this.tokensPerSecond) * 1000;
    
    if (!this.drainedAt) {
      this.drainedAt = Date.now();
    }

    console.log(
      `⏳ [RATE_LIMIT] Bucket drained. Waiting ${waitMs.toFixed(0)}ms before next request...`
    );

    await new Promise(resolve => setTimeout(resolve, Math.ceil(waitMs)));

    // Recursive call to ensure we have tokens
    this.tokens = 0; // Reset to trigger refill on next call
    return waitMs + (await this.waitForToken());
  }

  /**
   * Get current stats
   */
  getStats() {
    const available = this.getAvailableTokens();
    return {
      totalRequests: this.totalRequests,
      availableTokens: available,
      maxTokens: this.maxTokens,
      tokensPerSecond: this.tokensPerSecond,
      isDrained: available === 0,
    };
  }

  /**
   * Reset stats
   */
  reset() {
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
    this.totalRequests = 0;
    this.drainedAt = null;
  }
}

export const rateLimiter = new RateLimiter(
  parseInt(process.env.EMBED_REQUESTS_PER_MINUTE || "80", 10)
);

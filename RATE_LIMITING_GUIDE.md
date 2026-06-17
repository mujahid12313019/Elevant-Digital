# Production-Grade RAG Ingestion Pipeline
## Complete Guide to Rate Limiting & 429 Error Prevention

---

## Overview

This document explains the complete production-ready ingestion pipeline that prevents Gemini API **429 RESOURCE_EXHAUSTED** errors through:

1. **Rate Limiting** - Token bucket algorithm spreads requests
2. **Exponential Backoff** - Exponential delays with jitter on retries  
3. **Batch Processing** - Groups embeddings efficiently
4. **Deduplication** - Skips already-embedded chunks
5. **Resumable Ingestion** - MongoDB stores progress for crash recovery
6. **Structured Logging** - Detailed metrics for monitoring

---

## Architecture

### Services Overview

```
ingestBook.js (Main Pipeline)
├── embed.service.js (Gemini API with retries)
│   └── rateLimiter.service.js (Token bucket)
├── dedupe.service.js (Duplicate detection)
├── progress.service.js (MongoDB progress tracking)
├── extractTitle.js (Title extraction)
├── chunkText.js (Text chunking)
└── logger.js (Structured logging)
```

---

## How It Prevents 429 Errors

### 1. Rate Limiting (Token Bucket Algorithm)

**File:** `src/services/rateLimiter.service.js`

**How it works:**
- Maintains a "bucket" with tokens (default: 80 tokens for 80 requests/min)
- Tokens refill at 80/60 = 1.33 per second
- Each API request costs 1 token
- If bucket is empty, request blocks until token available
- Blocks execution, creates backpressure → prevents burst requests

**Example flow:**
```
t=0s:   80 tokens available → make request → 79 tokens left
t=0.5s: tokens refill → ~80 tokens again
t=1s:   if bucket empty, WAIT until refilled
```

**Why it prevents 429:**
- ✓ Never sends more than 80 requests/min (vs Gemini free tier 100)
- ✓ Spreads requests evenly instead of bursting
- ✓ 20-request buffer for retries without exceeding quota

---

### 2. Exponential Backoff with Jitter

**File:** `src/services/embed.service.js`

**How it works:**
```javascript
delay = (2^retryCount * 1000ms) + random(0-1000ms)

Retry 1: 2^0 * 1000 + jitter = ~1000-2000ms
Retry 2: 2^1 * 1000 + jitter = ~2000-3000ms  
Retry 3: 2^2 * 1000 + jitter = ~4000-5000ms
Retry 4: 2^3 * 1000 + jitter = ~8000-9000ms
Retry 5: 2^4 * 1000 + jitter = ~16000-17000ms
```

**Jitter explanation:**
- Prevents "thundering herd" (all clients retrying at same time)
- Random 0-1000ms spread prevents synchronized spikes
- Helps server quota recover during backoff

**Why it prevents 429:**
- ✓ Respects "Retry-After" header if provided by server
- ✓ Exponential delays give quota time to recover
- ✓ Jitter prevents retry storms
- ✓ Up to 5 retries = good chance of success

---

### 3. Batch Processing

**File:** `src/services/embed.service.js`

**How it works:**
- Process chunks in batches (default: 10 per batch)
- Each batch loops through chunks sequentially with rate limiting
- Rate limiter applies BETWEEN REQUESTS, not between batches
- Configurable via `EMBED_BATCH_SIZE`

**Example (10 chunks/batch, 80 req/min):**
```
Batch 1: chunk 1→chunk 2→...→chunk 10
         [rate limit applied between each]
         Total time: ~7.5 seconds

Batch 2: chunk 11→chunk 12→...→chunk 20
         Same pattern...

Total for 100 chunks: ~75 seconds
```

**Why it prevents 429:**
- ✓ Batch size determines request frequency
- ✓ Smaller batches = more spread-out requests
- ✓ Configurable for different quota levels

---

### 4. Duplicate Detection

**File:** `src/services/dedupe.service.js`

**Two-level deduplication:**

**Level 1: Progress Tracking**
- Checks MongoDB for already-embedded chunks
- Skips if chunk was previously processed
- Enables resumable ingestion

**Level 2: Semantic Similarity**
- Vector search in Qdrant for >98% similar content
- Skips if found (saves embedding API call)

**Example:**
```
100 chunks → 20 already processed → 80 to embed
                                    → 15 semantic duplicates
                                    → 65 unique to embed
                                    
API calls needed: 65 (not 100!)
Quota saved: 35%
```

**Why it prevents 429:**
- ✓ Fewer API calls = lower quota consumption
- ✓ Resumable ingestion avoids re-embedding on restart
- ✓ Semantic dedup finds hidden duplicates

---

### 5. Resumable Ingestion

**File:** `src/services/progress.service.js`

**How it works:**
- Stores progress in MongoDB collection: `ingest_progress`
- Records: job ID, processed chunks, skipped chunks, failed chunks
- On restart, checks MongoDB and resumes from last checkpoint
- If server crashes mid-ingestion, no work is lost

**MongoDB schema:**
```javascript
{
  jobId: "abc123",
  bookName: "Contagious",
  totalChunks: 500,
  processedChunks: 320,
  skippedChunks: 45,
  failedChunks: 0,
  embeddedChunkIds: [0, 1, 2, ..., 319],
  status: "in-progress",
  createdAt: "2026-06-17T...",
  updatedAt: "2026-06-17T..."
}
```

**Why it prevents 429:**
- ✓ Restart doesn't re-embed completed chunks
- ✓ Partial failure doesn't waste quota
- ✓ Reduces total API calls on long ingestions

---

## Configuration

### Environment Variables

```bash
# Rate limiting (requests per minute)
EMBED_REQUESTS_PER_MINUTE=80        # Default: 80 (safe for 100/min quota)

# Batch processing
EMBED_BATCH_SIZE=10                 # Chunks per batch (default: 10)

# Retry behavior
EMBED_MAX_RETRIES=5                 # Max attempts before giving up

# MongoDB (optional, for resumable ingestion)
MONGODB_URI=mongodb+srv://...       # MongoDB Atlas connection
MONGODB_DB_NAME=rag_system

# Qdrant
QDRANT_URL=https://...              # Qdrant cluster URL
QDRANT_API_KEY=...

# Gemini
GEMINI_API_KEY=...
```

### Tuning for Your Quota

**Free tier (100 requests/min):**
```
EMBED_REQUESTS_PER_MINUTE=80        # Safe margin
EMBED_BATCH_SIZE=10
EMBED_MAX_RETRIES=5
```

**Pro tier (higher limits):**
```
EMBED_REQUESTS_PER_MINUTE=150       # Increase quota
EMBED_BATCH_SIZE=20                 # Larger batches
EMBED_MAX_RETRIES=3                 # Fewer retries needed
```

**Conservative mode (very important data):**
```
EMBED_REQUESTS_PER_MINUTE=60        # Extra safety margin
EMBED_BATCH_SIZE=5                  # Smaller batches
EMBED_MAX_RETRIES=10                # More forgiving
```

---

## API Usage

### Ingest a Book

```bash
curl -X POST http://localhost:3000/ingest \
  -H "Content-Type: application/json" \
  -d '{"text":"Your book content here..."}'
```

**Response:**
```json
{
  "success": true,
  "status": "processing",
  "jobId": "1j0s01-x1y2z3"
}
```

### Check Progress

```bash
curl http://localhost:3000/ingest/1j0s01-x1y2z3
```

**Response (in progress):**
```json
{
  "id": "1j0s01-x1y2z3",
  "status": "processing",
  "progress": 45,
  "result": null,
  "createdAt": "2026-06-17T...",
  "updatedAt": "2026-06-17T..."
}
```

**Response (completed):**
```json
{
  "id": "1j0s01-x1y2z3",
  "status": "completed",
  "progress": 100,
  "result": {
    "bookName": "Contagious",
    "totalChunks": 500,
    "embeddedChunks": 450,
    "skippedChunks": 50,
    "failedChunks": 0,
    "apiEfficiency": "90.0%",
    "rateLimiterStats": {
      "totalRequests": 450,
      "availableTokens": 80,
      "isDrained": false
    }
  }
}
```

---

## Monitoring & Logs

### Structured Logging Output

When ingesting, you'll see:

```
╔════════════════════════════════════════════════════════════╗
║ 📚 INGESTION STARTED                                       ║
║━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║
║ Job ID:        1j0s01-x1y2z3
║ Book:          Contagious
║ Total Chunks:  500
║ Start Time:    2026-06-17T10:30:45.123Z
╚════════════════════════════════════════════════════════════╝

📦 [BATCH 1/50] Starting 10 chunks...
  ✓ [10%] 50/500 | 30.5s | 
  ⏳ [RATE_LIMIT] Bucket drained. Waiting 800ms...
  ⚠️  [429 QUOTA] Attempt 1/5. Waiting 1.2s before retry...
  ✓ [12%] 60/500 | 31.5s |

...

╔════════════════════════════════════════════════════════════╗
║ ✓ INGESTION COMPLETED                                      ║
║━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║
║ Total Time:        65.3s
║ Processed:         450/500
║ Skipped:           50 (dedup/resume)
║ Failed:            0
║ Rate:              415.0 chunks/min
║ 429 Errors:        2
║ Backoff Wait:      3.4s
║ API Efficiency:    90.0%
╚════════════════════════════════════════════════════════════╝
```

### Key Metrics

- **API Efficiency** - Percentage of unique chunks embedded
  - High = good (less duplicate work)
  - Low = many duplicates (resume/dedup working)

- **429 Errors** - Count of quota exhaustion events
  - 0 = perfect (rate limiter working)
  - 1-3 = normal (occasional bursts)
  - >5 = rate limit too aggressive

- **Backoff Wait** - Total time spent waiting for retries
  - Should be <5% of total time
  - High value = quota frequently exhausted

---

## Error Handling

### Common Errors & Solutions

**Error: "Collection 'books' not found"**
```bash
# Solution: Create collection first
node embedding.js
```

**Error: "Embedding failed after 5 retries"**
- 429 error persisted through all retries
- Solution: Increase `EMBED_REQUESTS_PER_MINUTE` (too aggressive)
- Solution: Increase `EMBED_MAX_RETRIES` (more tolerance needed)
- Solution: Check Gemini API status

**Error: "MONGODB_URI not set"**
- MongoDB disabled (progress tracking off)
- Solution: Optional - ingestion still works but not resumable
- Solution: Add `MONGODB_URI` to .env for resumable ingestion

**Server crashes mid-ingestion**
- Job status stored in MongoDB
- Restart ingestion with same jobId to resume from checkpoint
- Already-embedded chunks will be skipped

---

## Performance Tuning

### For Speed (if quota available)

```
EMBED_REQUESTS_PER_MINUTE=200   # Increase if quota available
EMBED_BATCH_SIZE=30              # Larger batches
EMBED_MAX_RETRIES=3              # Fewer retries
```

### For Reliability (high importance data)

```
EMBED_REQUESTS_PER_MINUTE=50    # Conservative quota usage
EMBED_BATCH_SIZE=5               # Tiny batches = steady flow
EMBED_MAX_RETRIES=10             # Forgiving
```

### Memory Optimization

```
EMBED_BATCH_SIZE=3               # Smaller batches use less RAM
```

---

## Production Deployment

### On Render

1. **Set environment variables** in Render dashboard
2. **Initialize collection** before ingestion:
   ```bash
   node embedding.js
   ```
3. **Start server** - ingestion will run in background
4. **Monitor logs** - check structured logging output
5. **Resume on restart** - MongoDB tracks progress

### On AWS / Azure / GCP

Same pattern - set env vars, run `node embedding.js`, then `npm start`.

---

## Verification Checklist

- [ ] Rate limiter preventing burst requests
- [ ] 429 errors trigger exponential backoff
- [ ] Batch processing spreads requests evenly
- [ ] Duplicate detection skips similar chunks
- [ ] Progress tracking resumes on restart
- [ ] Structured logging shows detailed metrics
- [ ] API efficiency > 80% (duplicates being caught)
- [ ] No server crashes on embedding failures

---

## Support & Troubleshooting

Check logs for:
1. **Rate limit messages** - `⏳ [RATE_LIMIT]`
2. **Retry messages** - `⚠️ [429 QUOTA]`
3. **Batch progress** - `📦 [BATCH n/total]`
4. **Duplicates skipped** - `⊘ [SKIP]`
5. **Final summary** - Completion metrics

If still hitting 429 errors:
1. Reduce `EMBED_REQUESTS_PER_MINUTE` by 10
2. Reduce `EMBED_BATCH_SIZE` by 5
3. Increase `EMBED_MAX_RETRIES` by 2
4. Check Gemini API status page

---

## Code Examples

### Embedding with rate limiting (automatic)

```javascript
// This automatically respects rate limits!
const vector = await embedChunk(text);
```

### Embedding with retries (automatic)

```javascript
// This automatically retries up to 5 times on 429!
const { vectors, failed } = await embedBatch(chunks);
```

### Resuming interrupted ingestion

```javascript
// Same jobId will resume from MongoDB checkpoint
POST /ingest with same jobId
// Skips already-processed chunks automatically
```

---

## Summary

This production pipeline prevents 429 errors through:

1. **Rate Limiting** - Spreads 80 req/min max
2. **Backoff** - Exponential delays on failures
3. **Batching** - Configurable batch sizes
4. **Dedup** - Skips duplicates (saves quota)
5. **Resumable** - MongoDB checkpoints (no re-work)
6. **Logging** - Detailed metrics for monitoring

Result: **Safe, reliable ingestion without exceeding Gemini quotas** ✓

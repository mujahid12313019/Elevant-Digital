import { chunkText } from "./chunkText.js";
import { extractTitle } from "./extractTitle.js";
import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";
import { updateProgress, updateStatus, setJobResult } from "./jobManager.js";

export async function ingestBook(text) {
  // Input validation
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Invalid text: must be non-empty string");
  }

  // keep original behavior (synchronous) for backward compatibility
  const bookName = await extractTitle(text);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    throw new Error("No chunks extracted from text");
  }

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: chunks[i],
    });

    const vector = embedding.embeddings[0].values;

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
  }

  return {
    bookName,
    chunksStored: chunks.length,
  };
}

// Background ingestion with batching and progress updates
export async function ingestBookBackground(jobId, text, opts = {}) {
  const BATCH_SIZE = opts.batchSize || 50; // points per Qdrant insert
  const EMBED_BATCH = opts.embedBatchSize || 50; // try to embed this many at once

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Invalid text: must be non-empty string");
  }

  updateStatus(jobId, "processing");

  try {
    const bookName = await extractTitle(text);
    const chunks = chunkText(text);
    const total = chunks.length;

    if (total === 0) {
      throw new Error("No chunks extracted from text");
    }

    let processed = 0;
    let idCounter = Date.now();

    // helper to obtain embeddings for an array of contents
    async function embedBatch(contents) {
      if (!contents || contents.length === 0) return [];

      try {
        const res = await ai.models.embedContent({
          model: "gemini-embedding-001",
          contents,
        });

        // res.embeddings might be array or single
        if (Array.isArray(res.embeddings)) {
          return res.embeddings.map((e) => e.values);
        }

        // single embedding returned
        if (res.embeddings && res.embeddings[0]) {
          return [res.embeddings[0].values];
        }
      } catch (err) {
        // fall through to per-item embedding
        console.warn("batch embed failed, falling back to single embeds", err?.message);
      }

      // fallback: embed one-by-one
      const out = [];
      for (const c of contents) {
        try {
          const r = await ai.models.embedContent({ model: "gemini-embedding-001", contents: c });
          out.push(r.embeddings[0].values);
        } catch (e) {
          console.error(`Failed to embed chunk: ${e.message}`);
          throw e;
        }
      }
      return out;
    }

    // process chunks in batches for embedding and insertion
    for (let i = 0; i < total; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatch(slice);

      // create points in batches for Qdrant
      const points = [];
      for (let j = 0; j < vectors.length; j++) {
        points.push({
          id: ++idCounter,
          vector: vectors[j],
          payload: {
            bookName,
            chunkIndex: i + j,
            text: slice[j],
          },
        });

        // when points length reaches BATCH_SIZE, flush to Qdrant
        if (points.length >= BATCH_SIZE) {
          try {
            await qdrant.put("/collections/books/points", { points });
          } catch (err) {
            if (err.response?.status === 404) {
              throw new Error(`Collection 'books' not found. Run 'node embedding.js' first to create it.`);
            }
            throw err;
          }
          points.length = 0; // Clear array
        }
      }

      // flush any remaining points from this embedding batch
      if (points.length > 0) {
        try {
          await qdrant.put("/collections/books/points", { points });
        } catch (err) {
          if (err.response?.status === 404) {
            throw new Error(`Collection 'books' not found. Run 'node embedding.js' first to create it.`);
          }
          throw err;
        }
      }

      processed = Math.min(i + EMBED_BATCH, total);
      const percent = Math.round((processed / total) * 100);
      updateProgress(jobId, percent);
      console.log(`[INGEST] ${percent}% complete (${processed}/${total} chunks)`);
    }

    // finalize
    setJobResult(jobId, { bookName, chunksStored: total });
    updateProgress(jobId, 100);
    updateStatus(jobId, "completed");
    console.log(`[INGEST] Complete: "${bookName}" (${total} chunks stored)`);
    return { bookName, chunksStored: total };
  } catch (err) {
    console.error(`[INGEST] Failed: ${err.message}`);
    updateStatus(jobId, "failed", err?.message || String(err));
    throw err;
  }
}
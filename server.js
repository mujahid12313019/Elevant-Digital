import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { ingestBook, ingestBookBackground } from "./src/ingestion/ingestBook.js";
import { createJob, getJob, updateProgress, updateStatus } from "./src/ingestion/jobManager.js";
import { askQuestion } from "./src/retrieval/askQuestion.js";

dotenv.config();

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// Health check
app.get("/", (req, res) => {
  res.json({ status: "RAG server running" });
});

// INGEST (Google Drive → Make calls this)
app.post("/ingest", (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text required" });
    }

    // create job and return immediately
    const jobId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    createJob(jobId, { status: "queued", progress: 0 });

    // start background processing (don't await)
    (async () => {
      try {
        updateStatus(jobId, "processing");
        await ingestBookBackground(jobId, text);
      } catch (err) {
        console.error("Background ingest failed", err);
        updateStatus(jobId, "failed", err?.message || String(err));
      }
    })();

    res.json({ success: true, status: "processing", jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ingest failed" });
  }
});

// status route for jobs
app.get("/ingest/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

// ASK (Discord → Make → this API)
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "question required" });
    }

    const answer = await askQuestion(question);

    res.json(answer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ask failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
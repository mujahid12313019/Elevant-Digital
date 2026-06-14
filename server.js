import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { ingestBook } from "./src/ingestion/ingestBook.js";
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
app.post("/ingest", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text required" });
    }

    const result = await ingestBook(text);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ingest failed" });
  }
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
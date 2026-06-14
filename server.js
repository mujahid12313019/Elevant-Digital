import express from "express";
import bodyParser from "body-parser";

const app = express();

// 🔥 SAFE LIMIT (still needed but not critical now)
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

app.post("/chunk", (req, res) => {
  try {
    let text = req.body?.text;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text is required" });
    }

    // 🔥 CLEAN TEXT (VERY IMPORTANT)
    text = text.replace(/\s+/g, " ").trim();

    // 🔥 AUTO CHUNK SETTINGS
    const CHUNK_SIZE = 1200;
    const OVERLAP = 200;
    const STEP = CHUNK_SIZE - OVERLAP;

    const chunks = [];

    for (let i = 0; i < text.length; i += STEP) {
      chunks.push({
        id: chunks.length,
        content: text.slice(i, i + CHUNK_SIZE),
      });
    }

    return res.json({
      totalChunks: chunks.length,
      chunks,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(3000, () => console.log("Running"));
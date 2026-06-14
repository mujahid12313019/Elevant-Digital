import express from "express";

const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.post("/chunk", (req, res) => {
  const text = req.body.text;

  const size = 1000;
  const overlap = 200;

  let chunks = [];

  for (let i = 0; i < text.length(); i += (size - overlap)) {
    chunks.push(text.slice(i, i + size));
  }

  res.json({ chunks });
});

app.listen(3000, () => console.log("Running"));
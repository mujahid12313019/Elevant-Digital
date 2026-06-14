import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";

// detect book (simple version)
async function detectBook(question) {
  const res = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: `
Detect if a book name is mentioned.

Return JSON:
{ "book": "name or null" }

QUESTION:
${question}
`,
  });

  try {
    return JSON.parse(res.text).book;
  } catch {
    return null;
  }
}

export async function askQuestion(question) {
  const book = await detectBook(question);

  const queryVector = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: question,
  });

  const vector = queryVector.embeddings[0].values;

  // search filter
  const filter = book
    ? {
        must: [
          {
            key: "bookName",
            match: { value: book },
          },
        ],
      }
    : undefined;

  const searchRes = await qdrant.post("/collections/books/points/search", {
    vector,
    limit: 5,
    filter,
  });

  const contexts = searchRes.data.result
    .map((r) => r.payload.text)
    .join("\n\n");

  const final = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: `
Answer using context only:

CONTEXT:
${contexts}

QUESTION:
${question}
`,
  });

  return {
    question,
    bookDetected: book,
    answer: final.text,
  };
}
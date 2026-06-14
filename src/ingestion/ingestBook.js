import { chunkText } from "./chunkText.js";
import { extractTitle } from "./extractTitle.js";
import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";

export async function ingestBook(text) {
  const bookName = await extractTitle(text);
  const chunks = chunkText(text);

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
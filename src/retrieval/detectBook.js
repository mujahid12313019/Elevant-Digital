import { ai } from "../config/gemini.js";
import { qdrant } from "../config/qdrant.js";

// Detect which book the question is about
export async function detectBook(question) {
  try {
    // Optional: use LLM to detect book name from question
    // For now, return null to search all books
    return null;
  } catch (err) {
    console.error("Book detection failed:", err.message);
    return null;
  }
}
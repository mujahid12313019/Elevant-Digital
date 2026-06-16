import { ai } from "../config/gemini.js";
export async function extractTitle(text) {
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
Extract ONLY the book title.

Return JSON:
{ "title": "..." }

TEXT:
${text.slice(0, 3000)}  
`,
  });

  const raw = res.text;

  try {
    return JSON.parse(raw).title;
  } catch {
    return "Unknown Book";
  }
}
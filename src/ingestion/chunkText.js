export function chunkText(text, size = 1200, overlap = 200) {
  if (!text || typeof text !== "string") return [];

  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return [];

  const step = Math.max(1, size - overlap);
  const chunks = [];

  for (let i = 0; i < clean.length; i += step) {
    const chunk = clean.slice(i, i + size);
    if (chunk.trim()) {
      chunks.push(chunk);
    }
  }

  return chunks;
}
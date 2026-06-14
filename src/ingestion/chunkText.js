export function chunkText(text) {
  const clean = text.replace(/\s+/g, " ").trim();

  const size = 1200;
  const overlap = 200;
  const step = size - overlap;

  const chunks = [];

  for (let i = 0; i < clean.length; i += step) {
    chunks.push(clean.slice(i, i + size));
  }

  return chunks;
}
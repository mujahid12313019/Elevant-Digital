import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

if (!QDRANT_URL || !QDRANT_API_KEY) {
  throw new Error("QDRANT_URL and QDRANT_API_KEY required in .env");
}

console.log("📡 Qdrant URL:", QDRANT_URL);
console.log("🔑 API Key:", QDRANT_API_KEY.slice(0, 20) + "...");

try {
  const url = `${QDRANT_URL}/collections/books`;
  console.log("📍 Creating collection at:", url);
  
  const response = await axios.put(
    url,
    {
      vectors: {
        size: 3072,
        distance: "Cosine"
      }
    },
    {
      headers: {
        "api-key": QDRANT_API_KEY,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("✓ Collection 'books' created successfully", response.data);
} catch (err) {
  console.error("❌ Error details:");
  console.error("  Status:", err.response?.status);
  console.error("  Status Text:", err.response?.statusText);
  console.error("  Response:", err.response?.data);
  console.error("  Message:", err.message);
  
  if (err.response?.status === 400) {
    const errMsg = JSON.stringify(err.response?.data);
    if (errMsg.includes("already exists") || errMsg.includes("collection already exists")) {
      console.log("✓ Collection 'books' already exists");
    } else {
      console.error("Bad request - collection config issue");
      process.exit(1);
    }
  } else if (err.response?.status === 404) {
    console.error("\n⚠️  404 Not Found - Check:");
    console.error("  1. QDRANT_URL is correct");
    console.error("  2. API key has permissions");
    console.error("  3. Qdrant server is running");
    console.error("\nTrying alternative endpoint...");
    
    // Try with /api/collections endpoint
    try {
      const altUrl = `${QDRANT_URL}/api/collections/books`;
      console.log("  Trying:", altUrl);
      const response2 = await axios.put(
        altUrl,
        {
          vectors: {
            size: 3072,
            distance: "Cosine"
          }
        },
        {
          headers: {
            "api-key": QDRANT_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );
      console.log("✓ Collection created via /api/collections endpoint");
    } catch (err2) {
      console.error("Alternative endpoint also failed:", err2.message);
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}
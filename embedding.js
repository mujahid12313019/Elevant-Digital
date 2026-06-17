import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

if (!QDRANT_URL || !QDRANT_API_KEY) {
  throw new Error("QDRANT_URL and QDRANT_API_KEY required in .env");
}

try {
  const response = await axios.post(
    `${QDRANT_URL}/collections/books`,
    {
      vectors: {
        size: 3072,
        distance: "Cosine"
      }
    },
    {
      headers: {
        "api-key": QDRANT_API_KEY
      }
    }
  );
  console.log("✓ Collection 'books' created successfully", response.data);
} catch (err) {
  if (err.response?.status === 400 && err.response?.data?.status?.error === "collection already exists") {
    console.log("✓ Collection 'books' already exists");
  } else {
    console.error("✗ Failed to create collection:", err.response?.data || err.message);
    process.exit(1);
  }
}
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
await axios.put(
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

console.log("Collection created");
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export const qdrant = axios.create({
  baseURL: process.env.QDRANT_URL,
  headers: {
    "api-key": process.env.QDRANT_API_KEY,
  },
});
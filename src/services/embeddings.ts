`import OpenAI from "openai";
import { config } from "../config.js";

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export const EMBEDDING_DIMS = 1536;

export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: config.embeddingModel,
    input: text,
  });

  const vector = response.data[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error("Embedding provider returned empty vector");
  }

  return vector;
}

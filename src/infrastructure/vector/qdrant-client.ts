import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config/index.js";

export function createQdrantClient(): QdrantClient {
  return new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey || undefined,
    timeout: config.qdrantTimeoutMs,
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import { GoogleProvider } from "../../../src/providers/ai/google-provider.js";
import { ProviderRateLimitedError } from "../../../src/shared/errors/provider-errors.js";
import { loadConfig } from "../../../src/config/load.js";

function createMockGoogleClient(input: {
  generateContent?: (...args: unknown[]) => Promise<unknown>;
  embedContent?: (...args: unknown[]) => Promise<unknown>;
}) {
  return {
    models: {
      generateContent: input.generateContent ?? (async () => ({
        text: "ok",
        candidates: [{ finishReason: "STOP" }],
      })),
      embedContent: input.embedContent ?? (async () => ({
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      })),
    },
  };
}

test("google provider maps chat requests to Gemini generateContent", async () => {
  let payload: unknown;
  const provider = new GoogleProvider({
    client: createMockGoogleClient({
      generateContent: async (input) => {
        payload = input;
        return { text: "{\"ok\":true}", candidates: [{ finishReason: "STOP" }] };
      },
    }) as never,
    defaultChatModel: "gemini-2.0-flash",
    defaultEmbeddingModel: "gemini-embedding-001",
    defaultEmbeddingDimensions: 768,
  });

  const response = await provider.chat({
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "hello" },
    ],
    responseFormat: "json_object",
    temperature: 0,
  });

  assert.equal(response.text, "{\"ok\":true}");
  assert.equal(response.model, "gemini-2.0-flash");
  assert.equal(response.finishReason, "STOP");
  assert.deepEqual((payload as { config: Record<string, unknown> }).config.responseMimeType, "application/json");
});

test("google provider returns embedding vectors", async () => {
  let payload: unknown;
  const provider = new GoogleProvider({
    client: createMockGoogleClient({
      embedContent: async (input) => {
        payload = input;
        return { embeddings: [{ values: [0.4, 0.5] }, { values: [0.6, 0.7] }] };
      },
    }) as never,
    defaultChatModel: "gemini-2.0-flash",
    defaultEmbeddingModel: "gemini-embedding-001",
    defaultEmbeddingDimensions: 768,
  });

  const response = await provider.embed({ input: ["one", "two"], dimensions: 512 });

  assert.equal(response.model, "gemini-embedding-001");
  assert.deepEqual(response.vectors, [[0.4, 0.5], [0.6, 0.7]]);
  assert.deepEqual((payload as { contents: string[] }).contents, ["one", "two"]);
  assert.equal((payload as { config: { outputDimensionality: number } }).config.outputDimensionality, 512);
});

test("google provider maps rate limit errors", async () => {
  const provider = new GoogleProvider({
    client: createMockGoogleClient({
      generateContent: async () => {
        throw Object.assign(new Error("quota exhausted"), { status: 429 });
      },
    }) as never,
    defaultChatModel: "gemini-2.0-flash",
    defaultEmbeddingModel: "gemini-embedding-001",
    defaultEmbeddingDimensions: 768,
  });

  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "hello" }] }),
    (error: unknown) => error instanceof ProviderRateLimitedError
  );
});

test("google provider config can select Gemini and Vertex document search", () => {
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "secret",
    TALLEI_DB__URL: "postgresql://user:pass@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__PROVIDER: "google",
    TALLEI_EMBED__PROVIDER: "google",
    TALLEI_GOOGLE__PROJECT_ID: "project-1",
    TALLEI_GOOGLE__LOCATION: "us-central1",
    TALLEI_LLM__GOOGLE_MODEL: "gemini-test",
    TALLEI_EMBED__GOOGLE_MODEL: "embedding-test",
    TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH: "true",
    TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_SHADOW: "true",
    TALLEI_VERTEX_SEARCH__DATA_STORE: "datastore-1",
    TALLEI_VERTEX_SEARCH__SERVING_CONFIG: "serving-1",
  });

  assert.equal(cfg.llmProvider, "google");
  assert.equal(cfg.embeddingProvider, "google");
  assert.equal(cfg.googleModel, "gemini-test");
  assert.equal(cfg.googleEmbeddingModel, "embedding-test");
  assert.equal(cfg.vertexDocumentSearchEnabled, true);
  assert.equal(cfg.vertexDocumentSearchShadowEnabled, true);
});

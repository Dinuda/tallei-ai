import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import type { LogFields, Logger } from "../../../src/observability/index.js";
import { ProviderRateLimitedError } from "../../../src/shared/errors/provider-errors.js";
import { OpenAiProvider } from "../../../src/providers/ai/openai-provider.js";

interface LoggedEntry {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; entries: LoggedEntry[] } {
  const entries: LoggedEntry[] = [];

  const buildLogger = (baseFields: Record<string, unknown>): Logger => ({
    child(fields: LogFields): Logger {
      return buildLogger({ ...baseFields, ...fields });
    },
    debug(message: string, fields: LogFields = {}): void {
      entries.push({ message, fields: { ...baseFields, ...fields } });
    },
    info(message: string, fields: LogFields = {}): void {
      entries.push({ message, fields: { ...baseFields, ...fields } });
    },
    warn(message: string, fields: LogFields = {}): void {
      entries.push({ message, fields: { ...baseFields, ...fields } });
    },
    error(message: string, fields: LogFields = {}): void {
      entries.push({ message, fields: { ...baseFields, ...fields } });
    },
  });

  return {
    logger: buildLogger({}),
    entries,
  };
}

function createMockClient(input: {
  chatCreate?: (...args: unknown[]) => Promise<unknown>;
  embedCreate?: (...args: unknown[]) => Promise<unknown>;
}): OpenAI {
  return {
    chat: {
      completions: {
        create: input.chatCreate ?? (async () => ({
          model: "gpt-4o-mini",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })),
      },
    },
    embeddings: {
      create: input.embedCreate ?? (async () => ({
        model: "text-embedding-3-small",
        data: [{ embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })),
    },
  } as unknown as OpenAI;
}

test("openai provider does not emit payload logs when logging is disabled", async () => {
  const capture = createCapturingLogger();
  const provider = new OpenAiProvider({
    client: createMockClient({}),
    defaultChatModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
    defaultEmbeddingDimensions: 1536,
    payloadLoggingEnabled: false,
    payloadLoggingMaxChars: 2000,
    logger: capture.logger,
  });

  const result = await provider.chat({
    messages: [{ role: "user", content: "secret prompt content" }],
  });

  assert.equal(result.text, "ok");
  assert.equal(capture.entries.length, 0);
});

test("openai provider emits redacted payload logs for chat calls", async () => {
  const capture = createCapturingLogger();
  const provider = new OpenAiProvider({
    client: createMockClient({
      chatCreate: async () => ({
        model: "gpt-4o-mini",
        choices: [{ message: { content: "super private completion" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    }),
    defaultChatModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
    defaultEmbeddingDimensions: 1536,
    payloadLoggingEnabled: true,
    payloadLoggingMaxChars: 2000,
    logger: capture.logger,
  });

  const result = await provider.chat({
    messages: [
      { role: "system", content: "do not leak system prompt" },
      { role: "user", content: "my password is abc123" },
    ],
    maxTokens: 50,
  });

  assert.equal(result.text, "super private completion");
  assert.equal(result.model, "gpt-4o-mini");
  assert.equal(result.finishReason, "stop");
  assert.equal(capture.entries.length, 1);

  const log = capture.entries[0]?.fields ?? {};
  assert.equal(log["event"], "openai_provider_call");
  assert.equal(log["capability"], "chat");
  assert.equal(log["success"], true);

  const serialized = JSON.stringify(log);
  assert.match(serialized, /"\[REDACTED\]"/);
  assert.ok(!serialized.includes("abc123"));
  assert.ok(!serialized.includes("super private completion"));
});

test("openai provider emits redacted payload logs for embedding calls without vectors", async () => {
  const capture = createCapturingLogger();
  const provider = new OpenAiProvider({
    client: createMockClient({
      embedCreate: async () => ({
        model: "text-embedding-3-small",
        data: [
          { embedding: [0.11, 0.22, 0.33] },
          { embedding: [0.44, 0.55, 0.66] },
        ],
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }),
    }),
    defaultChatModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
    defaultEmbeddingDimensions: 1536,
    payloadLoggingEnabled: true,
    payloadLoggingMaxChars: 2000,
    logger: capture.logger,
  });

  const result = await provider.embed({
    input: ["very secret text one", "very secret text two"],
  });

  assert.equal(result.vectors.length, 2);
  assert.equal(result.model, "text-embedding-3-small");
  assert.equal(capture.entries.length, 1);

  const log = capture.entries[0]?.fields ?? {};
  assert.equal(log["event"], "openai_provider_call");
  assert.equal(log["capability"], "embed");
  assert.equal(log["success"], true);

  const serialized = JSON.stringify(log);
  assert.ok(!serialized.includes("very secret text one"));
  assert.ok(!serialized.includes("very secret text two"));
  assert.ok(!serialized.includes("0.11"));
  assert.ok(!serialized.includes("0.66"));
  assert.match(serialized, /vector_count/);
  assert.match(serialized, /vector_dimensions/);
});

test("openai provider logs safe error metadata and rethrows mapped error", async () => {
  const capture = createCapturingLogger();
  const provider = new OpenAiProvider({
    client: createMockClient({
      chatCreate: async () => {
        const error = Object.assign(new Error("rate limit for secret prompt"), {
          status: 429,
          code: "rate_limit_exceeded",
        });
        throw error;
      },
    }),
    defaultChatModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
    defaultEmbeddingDimensions: 1536,
    payloadLoggingEnabled: true,
    payloadLoggingMaxChars: 2000,
    logger: capture.logger,
  });

  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "super sensitive prompt" }] }),
    (error: unknown) => error instanceof ProviderRateLimitedError
  );

  assert.equal(capture.entries.length, 1);
  const log = capture.entries[0]?.fields ?? {};
  assert.equal(log["success"], false);

  const serialized = JSON.stringify(log);
  assert.ok(!serialized.includes("super sensitive prompt"));
  assert.match(serialized, /rate_limit_exceeded/);
  assert.match(serialized, /"status":429/);
});

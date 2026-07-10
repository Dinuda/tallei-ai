import assert from "node:assert/strict";
import test from "node:test";

import { modelRegistry } from "../../../src/model/registry.js";
import { parseStructuredOutput, selectStructuredOutputStrategy } from "../../../src/model/validators/structured-output.js";
import { toLegacyChatMessages } from "../../../src/model/normalize/messages.js";
import { z } from "zod";

test("modelRegistry resolves chat route for OpenAI provider", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const configModule = await import("../../../src/config/index.js");
  Object.assign(configModule.config, loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
    TALLEI_LLM__CHAT_MODEL: "gpt-5-mini",
  }));

  const route = modelRegistry.resolveModelRoute({ purpose: "chat" });
  assert.equal(route.modelId, "gpt-5-mini");
  assert.equal(route.capabilities.surface, "responses");
});

test("modelRegistry resolveRequiredToolChoice forces a tool call on OpenCode provider", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const configModule = await import("../../../src/config/index.js");
  Object.assign(configModule.config, loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "opencode",
    TALLEI_LLM__OPENCODE_API_KEY: "oc-test-key",
  }));

  assert.equal(modelRegistry.resolveRequiredToolChoice(2), "required");
  const route = modelRegistry.resolveModelRoute({ purpose: "chat" });
  assert.equal(route.capabilities.surface, "opencode");
  assert.equal(route.capabilities.supportsForcedToolChoice, false);
});

test("toLegacyChatMessages filters tool messages and preserves text", () => {
  const messages = toLegacyChatMessages([
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Hello" },
    { role: "tool", content: "ignored", toolCallId: "call_1" },
    { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
  ]);
  assert.deepEqual(messages, [
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
});

test("selectStructuredOutputStrategy prefers native schema when supported", () => {
  assert.equal(
    selectStructuredOutputStrategy({
      supportsJsonSchema: true,
      supportsJsonMode: true,
      supportsTools: true,
    }),
    "native_schema",
  );
  assert.equal(
    selectStructuredOutputStrategy({
      supportsJsonSchema: false,
      supportsJsonMode: true,
      supportsTools: false,
    }),
    "json_mode",
  );
});

test("parseStructuredOutput repairs fenced JSON", async () => {
  const schema = z.object({ ok: z.boolean() });
  const parsed = await parseStructuredOutput(schema, '```json\n{"ok":true}\n```', "json_mode");
  assert.deepEqual(parsed.data, { ok: true });
  assert.equal(parsed.strategy, "json_mode");
});

test("gateway streaming resolver facade remains compatible", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const configModule = await import("../../../src/config/index.js");
  Object.assign(configModule.config, loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
    TALLEI_LLM__CHAT_MODEL: "gpt-5-mini",
  }));

  const { modelGateway } = await import("../../../src/model/gateway.js");
  const resolved = modelGateway.resolveStreaming("chat");
  assert.equal(resolved.modelId, "gpt-5-mini");
  assert.equal(resolved.surface, "responses");
});

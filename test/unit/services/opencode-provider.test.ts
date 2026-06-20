import assert from "node:assert/strict";
import test from "node:test";

test("loadConfig resolves OpenCode provider settings", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "opencode",
    TALLEI_LLM__OPENCODE_API_KEY: "oc-test-key",
    TALLEI_LOOP_BUILDER__OPENAI_MODEL: "gpt-5-mini",
    TALLEI_EMBED__PROVIDER: "ollama",
  });

  assert.equal(cfg.llmProvider, "opencode");
  assert.equal(cfg.opencodeApiKey, "oc-test-key");
  assert.equal(cfg.opencodeBaseUrl, "https://opencode.ai/zen/v1");
  assert.equal(cfg.openaiModel, "deepseek-v4-flash");
});

test("resolveLoopChatLanguageModel uses openai-compatible for OpenCode Zen chat models", async () => {
  process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-secret";
  process.env.TALLEI_DB__URL ??= "postgresql://tallei:tallei@localhost:5432/tallei";
  process.env.TALLEI_LLM__LOCAL_MODEL_MODE = "false";
  process.env.TALLEI_LLM__PROVIDER = "opencode";
  process.env.TALLEI_LLM__OPENCODE_API_KEY = "oc-test-key";

  const { resolveLoopChatLanguageModel } = await import("../../../src/services/llm/loop-chat-client.js?t=opencode");
  const model = resolveLoopChatLanguageModel("deepseek-v4-flash") as { provider?: string; modelId?: string };
  assert.equal(model.provider, "opencode.chat");
  assert.equal(model.modelId, "deepseek-v4-flash");
});

test("resolveLoopChatLanguageModel uses responses API for OpenCode Zen GPT models", async () => {
  process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-secret";
  process.env.TALLEI_DB__URL ??= "postgresql://tallei:tallei@localhost:5432/tallei";
  process.env.TALLEI_LLM__LOCAL_MODEL_MODE = "false";
  process.env.TALLEI_LLM__PROVIDER = "opencode";
  process.env.TALLEI_LLM__OPENCODE_API_KEY = "oc-test-key";

  const { resolveLoopChatLanguageModel } = await import("../../../src/services/llm/loop-chat-client.js?t=opencode-gpt");
  const model = resolveLoopChatLanguageModel("gpt-5-mini") as { provider?: string; modelId?: string };
  assert.equal(model.provider, "openai.responses");
  assert.equal(model.modelId, "gpt-5-mini");
});

test("normalizeOpenCodeBaseUrl rewrites legacy Go endpoint to Zen chat completions", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "opencode",
    TALLEI_LLM__OPENCODE_API_KEY: "oc-test-key",
    TALLEI_LLM__OPENCODE_BASE_URL: "https://opencode.ai/zen/go/v1",
    TALLEI_EMBED__PROVIDER: "ollama",
  });
  assert.equal(cfg.opencodeBaseUrl, "https://opencode.ai/zen/v1");
});

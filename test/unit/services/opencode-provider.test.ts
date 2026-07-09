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
    TALLEI_CONDUCTOR__MODEL: "gpt-5-mini",
    TALLEI_EMBED__PROVIDER: "ollama",
  });

  assert.equal(cfg.llmProvider, "opencode");
  assert.equal(cfg.opencodeApiKey, "oc-test-key");
  assert.equal(cfg.opencodeBaseUrl, "https://opencode.ai/zen/v1");
  assert.equal(cfg.openaiModel, "big-pickle");
  assert.equal(cfg.conductorModel, "big-pickle");
});

test("loadConfig resolves OpenAI conductor default without OpenCode model fallback", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test",
    TALLEI_EMBED__PROVIDER: "openai",
  });

  assert.equal(cfg.conductorModel, "gpt-5-mini");
});

test("loadConfig reads per-purpose reasoning effort", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test",
    TALLEI_CONDUCTOR__REASONING_EFFORT: "high",
    TALLEI_PLANNER__REASONING_EFFORT: "low",
  });

  assert.equal(cfg.conductorReasoningEffort, "high");
  assert.equal(cfg.plannerReasoningEffort, "low");
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

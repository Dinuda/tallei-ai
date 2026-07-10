import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceChatModelForOpenAiProvider,
  resolveChatModelForCompatibleProvider,
} from "../../../src/model/routing.js";
import { modelRegistry } from "../../../src/model/registry.js";

test("coerceChatModelForOpenAiProvider maps OpenCode model names to OpenAI default", () => {
  assert.equal(coerceChatModelForOpenAiProvider("big-pickle", "gpt-5-mini"), "gpt-5-mini");
  assert.equal(coerceChatModelForOpenAiProvider("gpt-5-mini", "gpt-5-mini"), "gpt-5-mini");
});

test("resolveChatModelForCompatibleProvider maps hosted OpenAI names to provider default", () => {
  assert.equal(resolveChatModelForCompatibleProvider("gpt-5-mini", "deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(resolveChatModelForCompatibleProvider("deepseek-v4-pro", "deepseek-v4-flash"), "deepseek-v4-pro");
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
  assert.equal(modelRegistry.resolveRequiredToolChoice(0), "none");
  assert.equal(modelRegistry.resolveRequiredToolChoice(2), "required");
  assert.equal(
    modelRegistry.resolveRequiredToolChoice(2, {
      nextTool: "resolveBindings",
      allowedTools: ["resolveBindings", "discoverBindings"],
    }),
    "required",
  );

  Object.assign(configModule.config, loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
  }));
  assert.equal(modelRegistry.resolveRequiredToolChoice(2), "required");
  assert.deepEqual(
    modelRegistry.resolveRequiredToolChoice(2, {
      nextTool: "listTriggers",
      allowedTools: ["listTriggers", "discoverBindings"],
    }),
    { type: "tool", toolName: "listTriggers" },
  );
  assert.equal(
    modelRegistry.resolveRequiredToolChoice(2, {
      nextTool: "listTriggers",
      allowedTools: ["discoverBindings"],
    }),
    "required",
  );
});

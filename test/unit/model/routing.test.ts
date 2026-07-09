import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceChatModelForOpenAiProvider,
  isLowConductorReasoningEffort,
  resolveChatModelForCompatibleProvider,
  resolveConductorModelForOpenAi,
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

test("resolveConductorModelForOpenAi picks nano for low reasoning and mini for higher tiers", () => {
  const tiers = { lowModel: "gpt-5-nano", highModel: "gpt-5-mini" };
  assert.equal(resolveConductorModelForOpenAi(undefined, tiers), "gpt-5-mini");
  assert.equal(resolveConductorModelForOpenAi("low", tiers), "gpt-5-nano");
  assert.equal(resolveConductorModelForOpenAi("minimal", tiers), "gpt-5-nano");
  assert.equal(resolveConductorModelForOpenAi("medium", tiers), "gpt-5-mini");
  assert.equal(resolveConductorModelForOpenAi("high", tiers), "gpt-5-mini");
  assert.equal(isLowConductorReasoningEffort("low"), true);
  assert.equal(isLowConductorReasoningEffort("high"), false);
});

test("modelRegistry resolveConductorToolChoice avoids forced tool choice on OpenCode provider", async () => {
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
  assert.equal(modelRegistry.resolveConductorToolChoice(0), "none");
  assert.equal(modelRegistry.resolveConductorToolChoice(2), "auto");

  Object.assign(configModule.config, loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
  }));
  assert.equal(modelRegistry.resolveConductorToolChoice(2), "required");
});

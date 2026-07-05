import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveChatModelForCompatibleProvider,
  resolveConductorToolChoice,
} from "../../../src/services/llm/chat-model-routing.js";

test("resolveChatModelForCompatibleProvider maps hosted OpenAI names to provider default", () => {
  assert.equal(resolveChatModelForCompatibleProvider("gpt-5-mini", "deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(resolveChatModelForCompatibleProvider("deepseek-v4-pro", "deepseek-v4-flash"), "deepseek-v4-pro");
});

test("resolveConductorToolChoice avoids forced tool choice on OpenCode Zen models", () => {
  assert.equal(resolveConductorToolChoice(0, "big-pickle"), "none");
  assert.equal(resolveConductorToolChoice(2, "big-pickle"), "auto");
  assert.equal(resolveConductorToolChoice(2, "deepseek-v4-flash-free"), "auto");
  assert.equal(resolveConductorToolChoice(2, "gpt-5.3-codex"), "required");
});

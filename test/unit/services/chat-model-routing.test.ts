import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatModelForCompatibleProvider } from "../../../src/services/llm/chat-model-routing.js";

test("resolveChatModelForCompatibleProvider maps hosted OpenAI names to provider default", () => {
  assert.equal(resolveChatModelForCompatibleProvider("gpt-5-mini", "deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(resolveChatModelForCompatibleProvider("deepseek-v4-pro", "deepseek-v4-flash"), "deepseek-v4-pro");
});

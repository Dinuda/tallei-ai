import assert from "node:assert/strict";
import test from "node:test";

import {
  openAiModelSupportsCustomTemperature,
  openAiTemperatureParam,
} from "../../../src/services/llm/openai-chat-params.js";

test("openAiModelSupportsCustomTemperature rejects nano and reasoning models", () => {
  assert.equal(openAiModelSupportsCustomTemperature("gpt-5-nano"), false);
  assert.equal(openAiModelSupportsCustomTemperature("gpt-5-mini"), false);
  assert.equal(openAiModelSupportsCustomTemperature("gpt-4.1-nano"), false);
  assert.equal(openAiModelSupportsCustomTemperature("o3-mini"), false);
  assert.equal(openAiModelSupportsCustomTemperature("gpt-gpt-5-nano"), true);
  assert.equal(openAiModelSupportsCustomTemperature("gpt-4o"), true);
});

test("openAiTemperatureParam omits temperature for fixed-temperature models", () => {
  assert.deepEqual(openAiTemperatureParam("gpt-5-nano", 0), {});
  assert.deepEqual(openAiTemperatureParam("gpt-4.1-nano", 0.3), {});
  assert.deepEqual(openAiTemperatureParam("gpt-gpt-5-nano", 0), { temperature: 0 });
  assert.deepEqual(openAiTemperatureParam("gpt-gpt-5-nano"), { temperature: 1 });
});

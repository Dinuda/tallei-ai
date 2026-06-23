import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAppSelectionSlugsFromUnknown,
  normalizeGetAvailableToolsInput,
  tryParseJsonWithClosingBraces,
} from "../../../src/services/conductor/inputs/get-available-tools-input.js";
import { createLoopBuilderToolCallRepair } from "../../../src/services/conductor/repair/tool-call-repair.js";
import { InvalidToolInputError, type ModelMessage } from "ai";

test("normalizeGetAvailableToolsInput accepts flat analyzer payloads", () => {
  const normalized = normalizeGetAvailableToolsInput({
    outcome: "Monitor Gmail support tickets",
    cadence: "hourly",
    approvalModel: "agent_autonomous",
    selectedToolkits: ["gmail"],
    capabilityQueries: ["fetch unread support emails"],
  }, "fallback goal");

  assert.equal(normalized.outcome, "Monitor Gmail support tickets");
  assert.equal(normalized.resolvedIntent, "Monitor Gmail support tickets");
  assert.deepEqual(normalized.selectedToolkits, ["gmail"]);
  assert.deepEqual(normalized.capabilityQueries, ["fetch unread support emails"]);
});

test("normalizeGetAvailableToolsInput accepts legacy nested payloads", () => {
  const normalized = normalizeGetAvailableToolsInput({
    normalizedIntent: {
      outcome: "Monitor Gmail support tickets",
      cadence: "hourly",
      approvalModel: "agent_autonomous",
    },
    resolvedIntent: "Monitor Gmail support tickets hourly",
    selectedToolkits: ["Gmail"],
  }, "fallback goal");

  assert.equal(normalized.outcome, "Monitor Gmail support tickets");
  assert.equal(normalized.resolvedIntent, "Monitor Gmail support tickets hourly");
  assert.deepEqual(normalized.selectedToolkits, ["gmail"]);
});

test("normalizeGetAvailableToolsInput removes internal AI dependencies", () => {
  const normalized = normalizeGetAvailableToolsInput({
    outcome: "Classify support tickets and draft replies",
    selectedToolkits: ["Zendesk", "OpenAI", "gmail", "anthropic"],
    assumptions: [
      "The loop runs continuously, reacting to new or updated tickets.",
      "Drafted replies require operator approval before being sent to the customer.",
      "The specific ticketing platform, AI classification model, and messaging channels will be chosen later.",
    ],
  }, "fallback goal");

  assert.deepEqual(normalized.selectedToolkits, ["zendesk", "gmail"]);
  assert.deepEqual(normalized.assumptions, [
    "The loop runs continuously, reacting to new or updated tickets.",
    "Drafted replies require operator approval before being sent to the customer.",
  ]);
});

test("tryParseJsonWithClosingBraces repairs truncated getAvailableTools JSON", () => {
  const truncated = "{\"normalizedIntent\": {\"outcome\":\"Monitor Gmail support tickets\",\"cadence\":\"hourly\",\"approvalModel\":\"agent_autonomous\"}";
  const parsed = tryParseJsonWithClosingBraces(truncated);
  assert.deepEqual(parsed, {
    normalizedIntent: {
      outcome: "Monitor Gmail support tickets",
      cadence: "hourly",
      approvalModel: "agent_autonomous",
    },
  });
});

test("createLoopBuilderToolCallRepair fills missing toolkits from appSelection output", async () => {
  const repair = createLoopBuilderToolCallRepair("Monitor Gmail support");
  const truncated = "{\"normalizedIntent\": {\"outcome\":\"Monitor Gmail support tickets\",\"cadence\":\"hourly\",\"approvalModel\":\"agent_autonomous\"}";
  const error = new InvalidToolInputError({
    toolName: "getAvailableTools",
    toolInput: truncated,
    cause: new Error("JSON parsing failed"),
  });

  const repaired = await repair({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "getAvailableTools",
      input: truncated,
    },
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [{
      role: "assistant",
      content: [{
        type: "tool-result",
        toolCallId: "app_1",
        toolName: "appSelection",
        output: {
          selectedToolkits: [{ slug: "gmail", name: "Gmail" }],
          answerText: "Use Gmail",
        },
      }],
    } satisfies ModelMessage],
    error,
  });

  assert.ok(repaired);
  const input = JSON.parse(repaired!.input);
  assert.equal(input.outcome, "Monitor Gmail support tickets");
  assert.deepEqual(input.selectedToolkits, ["gmail"]);
});

test("createLoopBuilderToolCallRepair ignores AI provider slugs from appSelection output", async () => {
  const repair = createLoopBuilderToolCallRepair("Monitor support tickets");
  const truncated = "{\"outcome\":\"Monitor support tickets\"";
  const error = new InvalidToolInputError({
    toolName: "getAvailableTools",
    toolInput: truncated,
    cause: new Error("JSON parsing failed"),
  });

  const repaired = await repair({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "getAvailableTools",
      input: truncated,
    },
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [{
      role: "assistant",
      content: [{
        type: "tool-result",
        toolCallId: "app_1",
        toolName: "appSelection",
        output: {
          selectedToolkits: [
            { slug: "zendesk", name: "Zendesk" },
            { slug: "openai", name: "OpenAI" },
            { slug: "gmail", name: "Gmail" },
          ],
          answerText: "Use Zendesk, OpenAI, and Gmail",
        },
      }],
    } satisfies ModelMessage],
    error,
  });

  assert.ok(repaired);
  const input = JSON.parse(repaired!.input);
  assert.deepEqual(input.selectedToolkits, ["zendesk", "gmail"]);
});

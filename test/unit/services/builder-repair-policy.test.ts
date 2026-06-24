import assert from "node:assert/strict";
import test from "node:test";

import { InvalidToolInputError } from "ai";

import { classifyBuilderRepairFailure } from "../../../src/services/conductor/builder/repair-policy.js";
import { createLoopBuilderToolCallRepair } from "../../../src/services/conductor/repair/tool-call-repair.js";

test("classifier marks malformed JSON as retryable", () => {
  const decision = classifyBuilderRepairFailure({
    toolName: "artifactSetup",
    error: new InvalidToolInputError({
      toolName: "artifactSetup",
      toolInput: "{bad json",
      cause: new Error("JSON parsing failed: unexpected end of input"),
    }),
  });

  assert.equal(decision.classification, "retryable_json_shape");
  assert.equal(decision.outcome, "repair_and_retry");
});

test("classifier pauses immediately for unavailable pseudo-tool calls", () => {
  const decision = classifyBuilderRepairFailure({
    toolName: "assistantMessage",
    error: new Error("Model tried to call unavailable tool 'assistantMessage'. Available tools: getAvailableTools, appSelection"),
  });

  assert.equal(decision.classification, "pause_unavailable_tool_or_connector");
  assert.equal(decision.outcome, "pause_for_repair");
});

test("repair loop pauses with repairPrompt after exhausting retry budget", async () => {
  const repair = createLoopBuilderToolCallRepair("Support inbox loop");
  const brokenInput = "{\"requirementId\":\"review_policy\",\"question\":\"How review?\",\"options\":[{\"id\":\"draft_only\",\"label\":\"Draft only\",\"value\":\"draft_only\"}],\"allowOther\":true";
  const error = new InvalidToolInputError({
    toolName: "requirementSetup",
    toolInput: brokenInput,
    cause: new Error("JSON parsing failed"),
  });

  const toolCall = {
    type: "tool-call" as const,
    toolCallId: "call_retry_budget",
    toolName: "requirementSetup",
    input: brokenInput,
  };

  const first = await repair({
    toolCall,
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [],
    error,
  });
  const second = await repair({
    toolCall,
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [],
    error,
  });
  const third = await repair({
    toolCall,
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [],
    error,
  });

  assert.ok(first);
  assert.equal(first!.toolName, "requirementSetup");
  assert.ok(second);
  assert.equal(second!.toolName, "requirementSetup");
  assert.ok(third);
  assert.equal(third!.toolName, "repairPrompt");
  assert.equal(JSON.parse(third!.input).blockedAction, "requirementSetup");
});

test("repair loop pauses immediately for unavailable tool failures", async () => {
  const repair = createLoopBuilderToolCallRepair("Support inbox loop");
  const repaired = await repair({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_unavailable",
      toolName: "assistantMessage",
      input: "{}",
    },
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [],
    error: new Error("Model tried to call unavailable tool 'assistantMessage'. Available tools: getAvailableTools, appSelection"),
  });

  assert.ok(repaired);
  assert.equal(repaired!.toolName, "repairPrompt");
});

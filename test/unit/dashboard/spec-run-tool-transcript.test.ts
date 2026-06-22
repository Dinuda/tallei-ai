import assert from "node:assert/strict";
import test from "node:test";

import { mergePartsForStep, mergeToolPartIntoParts } from "../../../src/services/loop-runtime/run-tool-merge.ts";

test("mergeToolPartIntoParts updates in-flight tool rows without changing order", () => {
  const memoryPending = {
    type: "tool-searchMemory",
    toolCallId: "call-memory",
    state: "input-available",
    input: { query: "support ticket classification" },
  };
  const gmailPending = {
    type: "dynamic-tool",
    toolName: "action_gmail_GMAIL_FETCH_EMAILS",
    toolCallId: "call-gmail",
    state: "input-available",
    input: {},
  };
  const memoryDone = {
    ...memoryPending,
    state: "output-available",
    output: { sources: [{ id: "1" }], reused: false },
  };
  const gmailDone = {
    ...gmailPending,
    state: "output-available",
    output: { ok: true },
  };

  let merged = mergeToolPartIntoParts([], memoryPending);
  merged = mergeToolPartIntoParts(merged, gmailPending);
  merged = mergeToolPartIntoParts(merged, memoryDone);
  merged = mergeToolPartIntoParts(merged, gmailDone);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.type, "tool-searchMemory");
  assert.equal((merged[0] as { state?: string }).state, "output-available");
  assert.equal(merged[1]?.type, "dynamic-tool");
  assert.equal((merged[1] as { state?: string }).state, "output-available");
});

test("mergePartsForStep preserves chronological tool order across message flushes", () => {
  const merged = mergePartsForStep([
    {
      id: "assistant-a",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 0 } },
        {
          type: "tool-searchMemory",
          toolCallId: "call-memory",
          state: "output-available",
          input: { query: "support ticket classification" },
          output: { sources: [], reused: false },
        },
      ],
    },
    {
      id: "assistant-b",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 0 } },
        {
          type: "dynamic-tool",
          toolName: "action_gmail_GMAIL_FETCH_EMAILS",
          toolCallId: "call-gmail",
          state: "output-available",
          input: {},
          output: { ok: true },
        },
      ],
    },
  ]);

  const toolTypes = merged
    .filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool")
    .map((part) => ("toolName" in part && typeof part.toolName === "string") ? part.toolName : part.type);
  assert.deepEqual(toolTypes, ["tool-searchMemory", "action_gmail_GMAIL_FETCH_EMAILS"]);
});

test("mergeToolPartIntoParts dedupes equivalent search tools with different call ids", () => {
  const first = {
    type: "tool-searchMemory",
    toolCallId: "call-memory-a",
    state: "input-available",
    input: { query: "support ticket classification priority" },
  };
  const second = {
    ...first,
    toolCallId: "call-memory-b",
    state: "output-available",
    output: { sources: [{ id: "source-1" }] },
  };

  let merged = mergeToolPartIntoParts([], first);
  merged = mergeToolPartIntoParts(merged, second);

  assert.equal(merged.length, 1);
  assert.equal((merged[0] as { toolCallId?: string }).toolCallId, "call-memory-b");
  assert.equal((merged[0] as { state?: string }).state, "output-available");
});

test("mergeToolPartIntoParts dedupes equivalent Gmail reads but keeps distinct calls", () => {
  const first = {
    type: "dynamic-tool",
    toolName: "action_gmail_GMAIL_FETCH_EMAILS",
    toolCallId: "call-gmail-a",
    state: "output-available",
    input: { max_results: 20 },
    output: { ok: true },
  };
  const duplicate = {
    ...first,
    toolCallId: "call-gmail-b",
  };
  const distinct = {
    ...first,
    toolCallId: "call-gmail-c",
    input: { max_results: 50 },
  };

  let merged = mergeToolPartIntoParts([], first);
  merged = mergeToolPartIntoParts(merged, duplicate);
  merged = mergeToolPartIntoParts(merged, distinct);

  assert.equal(merged.length, 2);
  assert.equal((merged[0] as { toolCallId?: string }).toolCallId, "call-gmail-b");
  assert.equal((merged[1] as { toolCallId?: string }).toolCallId, "call-gmail-c");
});

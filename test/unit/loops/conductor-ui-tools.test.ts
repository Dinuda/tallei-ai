import assert from "node:assert/strict";
import test from "node:test";

import type { UIMessage } from "ai";

import { repairStaleOutcomeBriefConfirms } from "../../../src/loops/conductor-chat.js";

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts };
}

test("repairStaleOutcomeBriefConfirms closes orphaned confirmOutcomeBrief calls", () => {
  const messages: UIMessage[] = [
    assistantMessage("a1", [
      {
        type: "tool-reviewOutcomeBrief",
        toolCallId: "review-old",
        state: "output-available",
        input: {},
        output: { briefHash: "hash-a", brief: { outcome: "Old" } },
      } as UIMessage["parts"][number],
      {
        type: "tool-confirmOutcomeBrief",
        toolCallId: "confirm-old",
        state: "input-available",
        input: { briefHash: "hash-a" },
      } as UIMessage["parts"][number],
    ]),
    assistantMessage("a2", [
      {
        type: "tool-reviewOutcomeBrief",
        toolCallId: "review-new",
        state: "output-available",
        input: {},
        output: { briefHash: "hash-b", brief: { outcome: "New" } },
      } as UIMessage["parts"][number],
    ]),
  ];

  const repaired = repairStaleOutcomeBriefConfirms(messages);
  const confirm = repaired[0]?.parts?.find((part) => part.type === "tool-confirmOutcomeBrief") as {
    state?: string;
    output?: { action?: string; briefHash?: string; otherText?: string };
  };

  assert.equal(confirm?.state, "output-available");
  assert.equal(confirm?.output?.action, "other");
  assert.equal(confirm?.output?.briefHash, "hash-a");
  assert.match(confirm?.output?.otherText ?? "", /Superseded/i);
});

test("repairStaleOutcomeBriefConfirms keeps active confirmOutcomeBrief matching latest review", () => {
  const messages: UIMessage[] = [
    assistantMessage("a1", [
      {
        type: "tool-reviewOutcomeBrief",
        toolCallId: "review-new",
        state: "output-available",
        input: {},
        output: { briefHash: "hash-b", brief: { outcome: "New" } },
      } as UIMessage["parts"][number],
      {
        type: "tool-confirmOutcomeBrief",
        toolCallId: "confirm-active",
        state: "input-available",
        input: { briefHash: "hash-b" },
      } as UIMessage["parts"][number],
    ]),
  ];

  const repaired = repairStaleOutcomeBriefConfirms(messages);
  const confirm = repaired[0]?.parts?.find((part) => part.type === "tool-confirmOutcomeBrief") as {
    state?: string;
    output?: unknown;
  };

  assert.equal(confirm?.state, "input-available");
  assert.equal(confirm?.output, undefined);
});

test("repairStaleOutcomeBriefConfirms keeps latest confirm even when hash mismatches review", () => {
  const messages: UIMessage[] = [
    assistantMessage("a1", [
      {
        type: "tool-reviewOutcomeBrief",
        toolCallId: "review-new",
        state: "output-available",
        input: {},
        output: { briefHash: "hash-b", brief: { outcome: "New" } },
      } as UIMessage["parts"][number],
      {
        type: "tool-confirmOutcomeBrief",
        toolCallId: "confirm-active",
        state: "input-available",
        input: { briefHash: "hash-a" },
      } as UIMessage["parts"][number],
    ]),
  ];

  const repaired = repairStaleOutcomeBriefConfirms(messages);
  const confirm = repaired[0]?.parts?.find((part) => part.type === "tool-confirmOutcomeBrief") as {
    state?: string;
    output?: unknown;
  };

  assert.equal(confirm?.state, "input-available");
  assert.equal(confirm?.output, undefined);
});

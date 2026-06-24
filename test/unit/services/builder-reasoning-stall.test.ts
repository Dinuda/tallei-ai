import assert from "node:assert/strict";
import test from "node:test";

test("patchReasoningOnlyAssistantMessages injects discovery fallback prompt", async () => {
  const {
    isReasoningOnlyAssistantMessage,
    patchReasoningOnlyAssistantMessages,
  } = await import("../../../src/services/conductor/builder/reasoning-stall.ts");

  const messages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Monitor support tickets and draft replies." }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Planning the first question.", state: "done" }],
    },
  ] as never[];

  assert.equal(isReasoningOnlyAssistantMessage(messages[1]!), true);

  const patched = patchReasoningOnlyAssistantMessages(messages, {
    builderState: "intent.collecting",
    goal: "Monitor support tickets and draft replies.",
    resolvedIntent: null,
  } as never);

  const tail = patched.at(-1);
  assert.equal(tail?.role, "assistant");
  const toolPart = tail?.parts.find((part) => part.type === "tool-intentClarification");
  assert.ok(toolPart);
  assert.equal(toolPart?.state, "input-available");
  assert.match(String((toolPart as { input?: { question?: string } }).input?.question ?? ""), /How should this loop run/i);
});

test("ensureBuilderProgressMessages injects schedule setup during requirements stalls", async () => {
  const { ensureBuilderProgressMessages } = await import(
    "../../../src/services/conductor/builder/reasoning-stall.ts"
  );

  const messages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Use Gmail for tickets." }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Need to ask about schedule next.", state: "done" }],
    },
  ] as never[];

  const patched = ensureBuilderProgressMessages(messages, {
    builderState: "requirements.resolving",
    goal: "Monitor support tickets",
    resolvedIntent: { resolvedIntent: "Monitor tickets" },
    discoveredToolContracts: [{ toolRef: "composio.gmail.search" }],
    buildContract: {
      requirements: [{
        id: "trigger_schedule",
        kind: "trigger_schedule",
        required: true,
        status: "unresolved",
        question: "How often should this loop run?",
      }],
    },
  } as never);

  const tail = patched.at(-1);
  const toolPart = tail?.parts.find((part) => part.type === "tool-scheduleSetup");
  assert.ok(toolPart);
  assert.equal(toolPart?.state, "input-available");
});

test("ensureBuilderProgressMessages appends assistant prompt after failed user-only turn", async () => {
  const { ensureBuilderProgressMessages } = await import(
    "../../../src/services/conductor/builder/reasoning-stall.ts"
  );

  const messages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Monitor support tickets and draft replies." }],
    },
  ] as never[];

  const patched = ensureBuilderProgressMessages(messages, {
    builderState: "intent.collecting",
    goal: "Monitor support tickets and draft replies.",
    resolvedIntent: null,
  } as never);

  assert.equal(patched.length, 2);
  assert.equal(patched[1]?.role, "assistant");
  const toolPart = patched[1]?.parts.find((part) => part.type === "tool-intentClarification");
  assert.ok(toolPart);
});

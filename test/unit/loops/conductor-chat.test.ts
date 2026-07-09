import assert from "node:assert/strict";
import test from "node:test";
import { convertToModelMessages, type UIMessage } from "ai";

import {
  findOrphanedToolCallIdsFromModelMessages,
  normalizeConductorChatMessages,
  prepareConductorChatMessagesForEventLog,
  prepareConductorModelMessagesForStream,
  sanitizeConductorChatMessagesForModelReplay,
} from "../../../src/loops/conductor-chat.js";
import { interruptionEventsForToolCallIds } from "../../../src/loops/build-events.js";

test("normalizeConductorChatMessages assigns ids to visible assistant turns missing an id", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "",
      role: "assistant",
      parts: [
        { type: "text", text: "Which review policy?" },
        {
          type: "tool-askQuestion",
          toolCallId: "q1",
          state: "input-available",
          input: {
            questionId: "review",
            question: "Review?",
            options: [
              { id: "a", label: "Yes", value: "yes" },
              { id: "b", label: "No", value: "no" },
            ],
          },
        },
      ],
    },
  ] as UIMessage[];

  const normalized = normalizeConductorChatMessages(messages);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.id, "user-1");
  assert.ok(normalized[1]?.id && normalized[1].id.length > 0);
  assert.notEqual(normalized[1]?.id, "");
});

test("normalizeConductorChatMessages drops empty assistant placeholders", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    { id: "assistant-empty", role: "assistant", parts: [] },
    { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Which trigger?" }] },
  ] satisfies UIMessage[];

  assert.deepEqual(
    normalizeConductorChatMessages(messages).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
});

test("normalizeConductorChatMessages preserves assistant usage metadata", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Done." }],
    metadata: {
      usage: {
        promptTokens: 120,
        completionTokens: 45,
        estimatedCostUsd: 0.0003,
      },
    },
  }] satisfies UIMessage[];

  const normalized = normalizeConductorChatMessages(messages);
  assert.deepEqual(normalized[0]?.metadata, messages[0]?.metadata);
});

test("normalizeConductorChatMessages drops assistant turns with only empty reasoning", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    { id: "assistant-empty-reasoning", role: "assistant", parts: [{ type: "reasoning", text: "   " }] },
    { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Which trigger?" }] },
  ] satisfies UIMessage[];

  assert.deepEqual(
    normalizeConductorChatMessages(messages).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
});

test("prepareConductorChatMessagesForEventLog preserves reasoning encrypted content", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "reasoning",
      text: "Planning connector setup",
      providerOptions: { openai: { itemId: "rs_123", reasoningEncryptedContent: "enc" } },
    }],
  }] satisfies UIMessage[];

  const sanitized = prepareConductorChatMessagesForEventLog(messages);
  const reasoning = sanitized[0]?.parts[0] as {
    providerOptions?: { openai?: { itemId?: string; reasoningEncryptedContent?: string } };
  };
  assert.equal(reasoning.providerOptions?.openai?.itemId, undefined);
  assert.equal(reasoning.providerOptions?.openai?.reasoningEncryptedContent, "enc");
});

test("normalizeConductorChatMessages preserves non-empty reasoning summaries", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "reasoning", text: "Weighing trigger options" }],
  }] satisfies UIMessage[];

  const normalized = normalizeConductorChatMessages(messages);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.parts[0]?.type, "reasoning");
});

test("prepareConductorChatMessagesForEventLog strips provider replay ids", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "reasoning",
      text: "Planning",
      providerOptions: { openai: { itemId: "rs_123" } },
    }],
  }] satisfies UIMessage[];

  const sanitized = prepareConductorChatMessagesForEventLog(messages);
  const reasoning = sanitized[0]?.parts[0] as { providerOptions?: { openai?: { itemId?: string } } };
  assert.equal(reasoning.providerOptions?.openai?.itemId, undefined);
});

test("sanitizeConductorChatMessagesForModelReplay auto-resolves continue replies for open confirmOutcomeBrief", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-confirmOutcomeBrief",
        toolCallId: "call-1",
        state: "input-available",
        input: {
          briefHash: "a".repeat(64),
          question: "Ready?",
          options: [
            { id: "confirm", label: "Yes", value: "confirm" },
            { id: "other", label: "No", value: "other" },
          ],
        },
      }],
    },
    { id: "user-2", role: "user", parts: [{ type: "text", text: "sure" }] },
    { id: "user-3", role: "user", parts: [{ type: "text", text: "go ahead" }] },
  ] satisfies UIMessage[];

  const { messages: replay, stats } = sanitizeConductorChatMessagesForModelReplay(messages, {
    preserveOpenUiToolCallIds: new Set(["call-1"]),
  });
  assert.deepEqual(stats.repairedToolCallIds, ["call-1"]);
  const repairedPart = replay[1]?.parts[0] as {
    state?: string;
    output?: { action?: string; briefHash?: string };
  };
  assert.equal(repairedPart.state, "output-available");
  assert.equal(repairedPart.output?.action, "confirm");
  assert.equal(repairedPart.output?.briefHash, "a".repeat(64));
});

test("sanitizeConductorChatMessagesForModelReplay repairs unresolved tool calls before later user messages", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-confirmOutcomeBrief",
        toolCallId: "call-1",
        state: "input-available",
        input: {
          briefHash: "a".repeat(64),
          question: "Ready?",
          options: [
            { id: "confirm", label: "Yes", value: "confirm" },
            { id: "other", label: "No", value: "other" },
          ],
        },
      }],
    },
    { id: "user-2", role: "user", parts: [{ type: "text", text: "change the trigger" }] },
    { id: "user-3", role: "user", parts: [{ type: "text", text: "go ahead" }] },
  ] satisfies UIMessage[];

  const { messages: replay, stats } = sanitizeConductorChatMessagesForModelReplay(messages);
  assert.deepEqual(stats.repairedToolCallIds, ["call-1"]);
  const repairedPart = replay[1]?.parts[0] as { state?: string; errorText?: string; output?: { skipped?: boolean } };
  assert.equal(repairedPart.state, "output-error");
  assert.equal(repairedPart.output?.skipped, true);
  assert.match(repairedPart.errorText ?? "", /Superseded by a later user message/);
});

test("sanitizeConductorChatMessagesForModelReplay leaves active pending prompts when no later user message exists", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-askQuestion",
        toolCallId: "call-1",
        state: "input-available",
        input: {
          questionId: "trigger",
          question: "How should this start?",
          options: [
            { id: "manual", label: "Manual", value: "manual" },
            { id: "email", label: "Email", value: "email" },
          ],
        },
      }],
    },
  ] satisfies UIMessage[];

  const { messages: replay, stats } = sanitizeConductorChatMessagesForModelReplay(messages);
  assert.deepEqual(stats.repairedToolCallIds, []);
  const part = replay[1]?.parts[0] as { state?: string };
  assert.equal(part.state, "input-available");
});

test("sanitizeConductorChatMessagesForModelReplay prunes empty assistant turns after aggressive repair", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "go ahead" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-analyzeIntent",
        toolCallId: "call-1",
        state: "input-available",
        input: { goal: "Monitor inbox" },
      }],
    },
    { id: "user-2", role: "user", parts: [{ type: "text", text: "sure" }] },
  ] satisfies UIMessage[];

  const aggressive = sanitizeConductorChatMessagesForModelReplay(messages, { aggressive: true });
  assert.deepEqual(aggressive.stats.repairedToolCallIds, ["call-1"]);
  assert.deepEqual(aggressive.messages.map((message) => message.id), ["user-1", "user-2"]);
});

test("prepareConductorModelMessagesForStream produces paired tool calls and results for replay", async () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-confirmOutcomeBrief",
        toolCallId: "call-1",
        state: "input-available",
        input: {
          briefHash: "a".repeat(64),
          question: "Ready?",
          options: [
            { id: "confirm", label: "Yes", value: "confirm" },
            { id: "other", label: "No", value: "other" },
          ],
        },
      }],
    },
    { id: "user-2", role: "user", parts: [{ type: "text", text: "sure" }] },
  ] satisfies UIMessage[];

  const prepared = await prepareConductorModelMessagesForStream(messages);
  assert.equal(findOrphanedToolCallIdsFromModelMessages(prepared.modelMessages).length, 0);
  assert.deepEqual(prepared.stats.repairedToolCallIds, ["call-1"]);
});

test("interruptionEventsForToolCallIds records superseded tool facts", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "call-1",
      state: "input-available",
      input: {
        questionId: "trigger",
        question: "How should this start?",
        options: [
          { id: "manual", label: "Manual", value: "manual" },
          { id: "email", label: "Email", value: "email" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  const events = interruptionEventsForToolCallIds(messages, ["call-1"]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "tool_call.interrupted");
  assert.equal(events[0]?.payload.desiredState, "output-error");
});

test("repaired replay history converts without orphaned tool calls", async () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-presentReplyOptions",
        toolCallId: "call-1",
        state: "input-available",
        input: {
          options: [
            { id: "yes", label: "Yes", message: "Yes" },
            { id: "no", label: "No", message: "No" },
          ],
        },
      }],
    },
    { id: "user-2", role: "user", parts: [{ type: "text", text: "go ahead" }] },
  ] satisfies UIMessage[];

  const { messages: replay } = sanitizeConductorChatMessagesForModelReplay(messages);
  const modelMessages = await convertToModelMessages(replay);
  assert.equal(findOrphanedToolCallIdsFromModelMessages(modelMessages).length, 0);
});

test("ensureVisibleConductorAssistantTurn appends fallback text for hidden-tool-only turns", async () => {
  const { ensureVisibleConductorAssistantTurn } = await import("../../../src/loops/conductor-chat.js");
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Summarize support tickets" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Planning trigger options" },
        {
          type: "tool-analyzeIntent",
          toolCallId: "call-1",
          state: "output-available",
          output: { ok: true },
        },
      ],
    },
  ] satisfies UIMessage[];

  const next = ensureVisibleConductorAssistantTurn(messages);
  const textPart = next[1]?.parts.find((part) => part.type === "text");
  assert.equal(textPart?.type, "text");
  assert.match("text" in textPart! ? textPart.text : "", /need one answer to continue/i);
});

test("ensureVisibleConductorAssistantTurn keeps pending askQuestion turns without fallback text", async () => {
  const { ensureVisibleConductorAssistantTurn } = await import("../../../src/loops/conductor-chat.js");
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Summarize support tickets" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-analyzeIntent",
          toolCallId: "call-1",
          state: "output-available",
          output: { ok: true },
        },
        {
          type: "tool-askQuestion",
          toolCallId: "call-2",
          state: "input-available",
          input: {
            questionId: "trigger",
            question: "How should this start?",
            options: [
              { id: "manual", label: "Manual", value: "manual" },
              { id: "email", label: "Email", value: "email" },
            ],
          },
        },
      ],
    },
  ] satisfies UIMessage[];

  const next = ensureVisibleConductorAssistantTurn(messages);
  assert.equal(next[1]?.parts.some((part) => part.type === "text"), false);
});

test("prepareConductorChatMessagesForEventLog injects fallback for invisible assistant turns", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Summarize support tickets" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-analyzeIntent",
        toolCallId: "call-1",
        state: "output-available",
        output: { ok: true },
      }],
    },
  ] satisfies UIMessage[];

  const sanitized = prepareConductorChatMessagesForEventLog(messages);
  const textPart = sanitized[1]?.parts.find((part) => part.type === "text");
  assert.equal(textPart?.type, "text");
  assert.match("text" in textPart! ? textPart.text : "", /need one answer to continue/i);
});

test("appendConductorStallRecoveryMessage adds retry guidance for blocked turns", async () => {
  const { appendConductorStallRecoveryMessage } = await import("../../../src/loops/conductor-chat.js");
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Still planning", state: "done" }],
    },
  ] satisfies UIMessage[];

  const next = appendConductorStallRecoveryMessage(messages, {
    stepsUsed: 0,
    outcome: "blocked",
  });
  const textPart = next[1]?.parts.find((part) => part.type === "text");
  assert.match("text" in textPart! ? textPart.text : "", /continue/i);
});

test("messagesPersistenceRevision ignores streaming reasoning token deltas", async () => {
  const { messagesPersistenceRevision } = await import("../../../src/loops/conductor-chat.js");
  const shortReasoning = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "reasoning", text: "abc", state: "streaming" }],
  }] satisfies UIMessage[];
  const longerReasoning = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "reasoning", text: "abcdef", state: "streaming" }],
  }] satisfies UIMessage[];

  assert.equal(
    messagesPersistenceRevision(shortReasoning),
    messagesPersistenceRevision(longerReasoning),
  );
});

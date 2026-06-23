import assert from "node:assert/strict";
import test from "node:test";

import type { UIMessage } from "ai";

import {
  detectBuilderRecoveryState,
  hydrateBuilderMessagesFromCommands,
  latestUserPromptText,
} from "../../../src/services/conductor/utils/session-recovery.js";

test("hydrateBuilderMessagesFromCommands preserves message reference when nothing changes", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-saveLoop",
      toolCallId: "tool-1",
      state: "output-available",
      output: { preview: true },
    }],
  }] as UIMessage[];

  const hydrated = hydrateBuilderMessagesFromCommands(messages, [{
    toolName: "saveLoop",
    status: "completed",
    result: { preview: true },
  }]);

  assert.equal(hydrated, messages);
});

test("hydrateBuilderMessagesFromCommands applies completed command output to pending tool parts", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-saveLoop",
      toolCallId: "tool-1",
      state: "input-available",
      input: { preview: true },
    }],
  }] as UIMessage[];

  const hydrated = hydrateBuilderMessagesFromCommands(messages, [{
    toolName: "saveLoop",
    status: "completed",
    result: { preview: true, spec: { title: "Support loop" } },
  }]);

  const part = hydrated[0]?.parts[0];
  assert.equal(part && "state" in part ? part.state : null, "output-available");
  assert.deepEqual(part && "output" in part ? part.output : null, {
    preview: true,
    spec: { title: "Support loop" },
  });
});

test("detectBuilderRecoveryState flags interrupted turns after refresh", () => {
  const state = detectBuilderRecoveryState({
    messages: [{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "continue" }],
    }],
    commands: [],
    chatStatus: "ready",
  });
  assert.equal(state.kind, "interrupted");
  assert.match(state.message, /issue while generating the response/i);
});

test("latestUserPromptText returns the latest non-empty user text without removing messages", () => {
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "first prompt" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "partial" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: " retry this " }] },
    { id: "a2", role: "assistant", parts: [{ type: "tool-saveLoop", toolCallId: "tool-1", state: "input-available", input: {} }] },
  ] as UIMessage[];

  assert.equal(latestUserPromptText(messages), "retry this");
  assert.equal(messages.length, 4);
});

test("detectBuilderRecoveryState does not flag pending UI requirement gates as interrupted", () => {
  const state = detectBuilderRecoveryState({
    messages: [{
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-requirementSetup",
        toolCallId: "tool-1",
        state: "input-available",
        input: {
          requirementId: "review_policy",
          question: "How should replies be reviewed before sending?",
          options: [
            { id: "each", label: "Approve each reply", value: "approve_each_action" },
            { id: "drafts", label: "Create drafts only", value: "draft_only" },
          ],
        },
      }],
    }],
    commands: [],
    chatStatus: "ready",
  });
  assert.equal(state.kind, "idle");
});

test("detectBuilderRecoveryState still flags pending backend command tools as interrupted", () => {
  const state = detectBuilderRecoveryState({
    messages: [{
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-saveLoop",
        toolCallId: "tool-1",
        state: "input-available",
        input: { preview: true },
      }],
    }],
    commands: [],
    chatStatus: "ready",
  });
  assert.equal(state.kind, "interrupted");
});

test("detectBuilderRecoveryState surfaces failed commands", () => {
  const state = detectBuilderRecoveryState({
    messages: [],
    commands: [{ id: "cmd-1", toolName: "saveLoop", status: "failed", error: "Save failed" }],
    chatStatus: "ready",
    sessionPhase: "failed",
  });
  assert.equal(state.kind, "failed");
  assert.match(state.message, /Save failed/);
});

test("detectBuilderRecoveryState ignores stale failed commands after a newer command settles", () => {
  const state = detectBuilderRecoveryState({
    messages: [{
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "You can continue from here." }],
    }],
    commands: [
      { id: "cmd-1", toolName: "saveLoop", status: "failed", error: "Old save failed" },
      { id: "cmd-2", toolName: "resolveBuildRequirement", status: "completed", result: { ok: true } },
    ],
    chatStatus: "ready",
    sessionPhase: "intent_resolved",
  });
  assert.equal(state.kind, "idle");
});

test("detectBuilderRecoveryState explains saveLoop infrastructure timeouts when build contract is resolved", () => {
  const state = detectBuilderRecoveryState({
    messages: [],
    commands: [{
      id: "cmd-1",
      toolName: "saveLoop",
      status: "failed",
      error: "Timed out contacting backend loop builder API",
    }],
    chatStatus: "ready",
    sessionPhase: "failed",
    buildContract: {
      requirements: [
        { required: true, status: "resolved" },
        { required: true, status: "resolved" },
      ],
    },
  });
  assert.equal(state.kind, "failed");
  assert.match(state.message, /temporary backend issue/i);
  assert.match(state.message, /setup choices are already saved/i);
});

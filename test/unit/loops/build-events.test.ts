import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import {
  appendLoopBuildEventsWithClient,
  eventPayloadHash,
  eventsFromUiMessages,
  hasCompletedConductorOperation,
  hasTerminalConductorPhaseResult,
  interruptionEventsForToolCallIds,
  interruptionEventsFromUiMessages,
  isTerminalConductorExecution,
  projectChatMessages,
} from "../../../src/loops/build-events.js";
import { isRecoverableConductorExecution } from "../../../src/loops/conductor-tools.js";

test("message snapshots produce stable lifecycle events and project the latest state", () => {
  const pending = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "tool-askQuestion", toolCallId: "call-1", state: "input-available", input: { question: "Scope?" } }],
  } as UIMessage;
  const completed = {
    ...pending,
    parts: [{ ...pending.parts[0], state: "output-available", output: { answerText: "Inbox" } }],
  } as UIMessage;
  const raw = [...eventsFromUiMessages([pending]), ...eventsFromUiMessages([completed])];
  const events = raw.map((event, index) => ({
    id: String(index), loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: index + 1, createdAt: new Date(0).toISOString(), toolCallId: event.toolCallId ?? null, ...event,
  }));
  assert.ok(events.some((event) => event.type === "tool_call.interrupted"));
  assert.ok(events.some((event) => event.type === "tool_call.completed"));
  assert.deepEqual(projectChatMessages(events), [completed]);
  assert.equal(eventPayloadHash({ b: 2, a: 1 }), eventPayloadHash({ a: 1, b: 2 }));
});

test("aborted tool calls are projected from explicit interruption events", () => {
  const message = {
    id: "assistant-aborted", role: "assistant",
    parts: [{ type: "tool-askQuestion", toolCallId: "question-1", state: "input-streaming", input: { question: "Scope?" } }],
  } as UIMessage;
  const raw = [...eventsFromUiMessages([message]), ...interruptionEventsFromUiMessages([message])];
  const events = raw.map((event, index) => ({
    id: String(index), loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: index + 1, createdAt: new Date(0).toISOString(), toolCallId: event.toolCallId ?? null, ...event,
  }));
  const part = projectChatMessages(events)[0]?.parts[0] as { state?: string };
  assert.equal(part.state, "input-available");
});

test("event appends are ordered and idempotent per thread", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("INSERT INTO loop_build_events")) {
        const events = JSON.parse(String(values[3])) as Array<Record<string, unknown>>;
        const appended = events.flatMap((event) => {
          if (rows.some((row) => row.event_key === event.eventKey)) return [];
          const row = {
            id: String(rows.length + 1), loop_id: values[0], thread_kind: values[1], run_id: values[2],
            sequence: rows.length + 1, event_key: event.eventKey, event_type: event.type,
            payload: event.payload, tool_call_id: event.toolCallId || null, created_at: new Date(0).toISOString(),
          };
          rows.push(row);
          return [row];
        });
        return { rows: appended };
      }
      return { rows: [] };
    },
  };
  const input = {
    client: client as never,
    loopId: "loop-1",
    events: [
      { eventKey: "one", type: "message.appended" as const, payload: { message: { id: "one" } } },
      { eventKey: "two", type: "artifact.committed" as const, payload: { state: { phase: "intent" } } },
    ],
  };
  const first = await appendLoopBuildEventsWithClient(input);
  const replay = await appendLoopBuildEventsWithClient(input);
  assert.deepEqual(first.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(replay, []);
});

test("semantic conductor dedupe matches different toolCallIds in the same revision", () => {
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-compileLoop",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output: {
          ok: false,
          operationKey: "compile:review-hash:compileLoop:compile:bindings-hash",
          phaseBefore: "compile",
          phaseAfter: "compile",
          phaseCompleted: false,
          requiresUserInput: false,
          retryAllowed: false,
          parentArtifactHash: "review-hash",
          invalidatedPhases: [],
          error: "Compilation failed",
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{
        type: "tool-compileLoop",
        toolCallId: "call-2",
        state: "output-available",
        input: {},
        output: {
          ok: false,
          operationKey: "compile:review-hash:compileLoop:compile:bindings-hash",
          phaseBefore: "compile",
          phaseAfter: "compile",
          phaseCompleted: false,
          requiresUserInput: false,
          retryAllowed: false,
          parentArtifactHash: "review-hash",
          invalidatedPhases: [],
          error: "Compilation failed",
        },
      }],
    },
  ] as UIMessage[];
  const events = eventsFromUiMessages(messages).map((event, index) => ({
    id: String(index),
    loopId: "loop",
    threadKind: "build" as const,
    runId: null,
    sequence: index + 1,
    createdAt: new Date(0).toISOString(),
    toolCallId: event.toolCallId ?? null,
    ...event,
  }));
  const lookup = {
    operationKey: "compile:review-hash:compileLoop:compile:bindings-hash",
    parentArtifactHash: "review-hash",
  };
  assert.equal(hasCompletedConductorOperation(events, lookup), true);
  assert.equal(hasTerminalConductorPhaseResult(events, { phase: "compile", parentArtifactHash: "review-hash" }), true);
  const last = events.at(-1);
  assert.ok(last);
  const metadata = last ? {
    ok: false,
    operationKey: lookup.operationKey,
    phaseBefore: "compile" as const,
    phaseAfter: "compile" as const,
    phaseCompleted: false,
    requiresUserInput: false,
    retryAllowed: false,
    parentArtifactHash: "review-hash",
    invalidatedPhases: [],
    error: "Compilation failed",
  } : null;
  assert.equal(Boolean(metadata && isTerminalConductorExecution(metadata)), true);
});

test("recoverable prerequisite failures are not terminal", () => {
  const metadata = {
    ok: false,
    operationKey: "compile:bindings-hash:compileLoop:compile:bindings-hash",
    phaseBefore: "compile" as const,
    phaseAfter: "compile" as const,
    phaseCompleted: false,
    requiresUserInput: false,
    retryAllowed: true,
    parentArtifactHash: "bindings-hash",
    invalidatedPhases: [],
    recoverToPhase: "review" as const,
    recoverReason: "confirm_outcome_brief_pending",
    resumeTool: "compileLoop",
    error: "Review isn't complete yet.",
  };
  assert.equal(isRecoverableConductorExecution(metadata), true);
  assert.equal(isTerminalConductorExecution(metadata), false);
  assert.equal(hasTerminalConductorPhaseResult([], {
    phase: "compile",
    parentArtifactHash: "bindings-hash",
  }), false);
});

test("hard compile failures without recovery remain terminal", () => {
  const metadata = {
    ok: false,
    operationKey: "compile:bindings-hash:compileLoop:compile:bindings-hash",
    phaseBefore: "compile" as const,
    phaseAfter: "compile" as const,
    phaseCompleted: false,
    requiresUserInput: false,
    retryAllowed: false,
    parentArtifactHash: "bindings-hash",
    invalidatedPhases: [],
    error: "Compilation failed",
  };
  assert.equal(isRecoverableConductorExecution(metadata), false);
  assert.equal(isTerminalConductorExecution(metadata), true);
});

test("semantic conductor dedupe does not cross revisions", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-compileLoop",
      toolCallId: "call-1",
      state: "output-available",
      input: {},
      output: {
        ok: true,
        operationKey: "compile:new-review-hash:compileLoop:compile:bindings-hash",
        phaseBefore: "compile",
        phaseAfter: "test",
        phaseCompleted: true,
        requiresUserInput: false,
        retryAllowed: true,
        parentArtifactHash: "new-review-hash",
        invalidatedPhases: [],
      },
    }],
  }] as UIMessage[];
  const events = eventsFromUiMessages(messages).map((event, index) => ({
    id: String(index),
    loopId: "loop",
    threadKind: "build" as const,
    runId: null,
    sequence: index + 1,
    createdAt: new Date(0).toISOString(),
    toolCallId: event.toolCallId ?? null,
    ...event,
  }));
  assert.equal(hasCompletedConductorOperation(events, {
    operationKey: "compile:review-hash:compileLoop:compile:bindings-hash",
    parentArtifactHash: "review-hash",
  }), false);
});

test("interruptionEventsForToolCallIds projects superseded prompts as output-error", () => {
  const message = {
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "question-1",
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
  } as UIMessage;
  const raw = interruptionEventsForToolCallIds([message], ["question-1"]);
  const events = raw.map((event, index) => ({
    id: String(index), loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: index + 1, createdAt: new Date(0).toISOString(), toolCallId: event.toolCallId ?? null, ...event,
  }));
  const part = projectChatMessages(events.concat(eventsFromUiMessages([message]).map((event, index) => ({
    id: String(index + 10), loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: index + 10, createdAt: new Date(0).toISOString(), toolCallId: event.toolCallId ?? null, ...event,
  }))))[0]?.parts[0] as { state?: string; errorText?: string };
  assert.equal(part.state, "output-error");
  assert.match(part.errorText ?? "", /Superseded by a later user message/);
});

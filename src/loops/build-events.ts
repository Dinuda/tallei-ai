import { createHash } from "node:crypto";
import type { UIMessage } from "ai";

import {
  isRecoverableConductorExecution,
  readConductorExecutionMetadata,
  type ConductorExecutionMetadata,
} from "./conductor-tools.js";

export const LOOP_BUILD_EVENT_TYPES = [
  "message.appended",
  "tool_call.requested",
  "tool_call.completed",
  "tool_call.errored",
  "tool_call.interrupted",
  "artifact.committed",
  "connector.auto_resolved",
  "binding.config_set",
  "binding.resolved",
  "binding.diagnostic",
  "phase_turn.completed",
  "phase.recovery_requested",
  "phase_handoff.consumed",
] as const;

export type LoopBuildEventType = (typeof LOOP_BUILD_EVENT_TYPES)[number];

export type LoopBuildEvent = {
  id: string;
  loopId: string;
  threadKind: "build" | "run";
  runId: string | null;
  sequence: number;
  eventKey: string;
  type: LoopBuildEventType;
  payload: Record<string, unknown>;
  toolCallId: string | null;
  createdAt: string;
};

export type ConductorOperationLookup = {
  operationKey: string;
  parentArtifactHash?: string | null;
};

export type ConductorPhaseTurnPayload = {
  phase: string;
  parentArtifactHash: string;
  stepsUsed: number;
  stepLimit: number;
  outcome: string;
  continuation: string;
  nextPhase?: string;
  handoffId?: string;
  compiledPlanId?: string;
  recoveryPhase?: string;
  recoveryReason?: string;
  noProgressFingerprint?: string;
  resolutionReason?: string;
  pendingToolCallId?: string;
  resumeAfterAnswer?: boolean;
};

export type NewLoopBuildEvent = Pick<LoopBuildEvent, "eventKey" | "type" | "payload"> & {
  toolCallId?: string | null;
};

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type LoopBuildEventRow = {
  id: string;
  loop_id: string;
  thread_kind: "build" | "run";
  run_id: string | null;
  sequence: number;
  event_key: string;
  event_type: LoopBuildEventType;
  payload: Record<string, unknown>;
  tool_call_id: string | null;
  created_at: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function eventPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function toolName(part: { type: string; toolName?: string }): string {
  return part.type === "dynamic-tool" && part.toolName
    ? part.toolName
    : part.type.replace(/^tool-/, "");
}

/** Convert AI SDK messages into idempotent persisted facts. */
export function eventsFromUiMessages(messages: UIMessage[]): NewLoopBuildEvent[] {
  const events: NewLoopBuildEvent[] = [];
  for (const message of messages) {
    const snapshotHash = eventPayloadHash(message);
    events.push({
      eventKey: `message:${message.id}:${snapshotHash}`,
      type: "message.appended",
      payload: { message },
    });
    for (const rawPart of message.parts ?? []) {
      const part = rawPart as {
        type: string;
        toolName?: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };
      if (!part.toolCallId || (!part.type.startsWith("tool-") && part.type !== "dynamic-tool")) continue;
      const name = toolName(part);
      const lifecycle = part.state === "output-available"
        ? "tool_call.completed"
        : part.state === "output-error"
          ? "tool_call.errored"
          : part.state === "input-available"
            ? "tool_call.interrupted"
            : "tool_call.requested";
      const payload = {
        messageId: message.id,
        toolName: name,
        state: part.state,
        input: part.input,
        output: part.output,
        errorText: part.errorText,
        ...readConductorExecutionMetadata(part.output),
      };
      events.push({
        eventKey: `tool:${part.toolCallId}:${lifecycle}:${eventPayloadHash(payload)}`,
        type: lifecycle,
        toolCallId: part.toolCallId,
        payload,
      });
    }
  }
  return events;
}

const HUMAN_INPUT_TOOLS = new Set(["askQuestion", "pickConnectorApp", "confirmOutcomeBrief", "presentReplyOptions"]);

export type PendingUiToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasResumableUiToolInput(toolName: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  switch (toolName) {
    case "askQuestion":
      return typeof input.questionId === "string"
        && input.questionId.trim().length > 0
        && typeof input.question === "string"
        && input.question.trim().length > 0
        && Array.isArray(input.options)
        && input.options.length >= 2;
    case "pickConnectorApp":
      return typeof input.outcomeId === "string" && input.outcomeId.trim().length > 0;
    case "presentReplyOptions":
      return Array.isArray(input.options) && input.options.length >= 2;
    case "confirmOutcomeBrief":
      return typeof input.briefHash === "string"
        && input.briefHash.trim().length > 0
        && typeof input.question === "string"
        && input.question.trim().length > 0
        && Array.isArray(input.options)
        && input.options.length >= 2;
    default:
      return true;
  }
}

function isOpenUiToolEvent(event: LoopBuildEvent): boolean {
  if (!event.toolCallId || event.type === "tool_call.completed") return false;
  const toolName = String(event.payload.toolName ?? "");
  if (!HUMAN_INPUT_TOOLS.has(toolName)) return false;
  if (event.type !== "tool_call.requested" && event.type !== "tool_call.interrupted") return false;
  const state = String(event.payload.state ?? "");
  if (state !== "input-available" && state !== "input-streaming") return false;
  if (event.payload.output != null) return false;
  return hasResumableUiToolInput(toolName, event.payload.input);
}

/** Latest UI-only tool call still awaiting user input, derived from persisted build events. */
export function derivePendingUiToolFromEvents(events: LoopBuildEvent[]): PendingUiToolCall | null {
  const completed = new Set(
    events
      .filter((event) => event.type === "tool_call.completed" && event.toolCallId)
      .map((event) => event.toolCallId as string),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!isOpenUiToolEvent(event) || !event.toolCallId || completed.has(event.toolCallId)) continue;
    return {
      toolCallId: event.toolCallId,
      toolName: String(event.payload.toolName ?? ""),
      input: event.payload.input,
    };
  }
  return null;
}

export function countUncompletedUiToolRequests(
  events: LoopBuildEvent[],
  toolName: string,
  inputFingerprint?: string,
): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== "tool_call.requested" || event.payload.toolName !== toolName || !event.toolCallId) continue;
    if (inputFingerprint) {
      const input = event.payload.input;
      const briefHash = isRecord(input) ? String(input.briefHash ?? "") : "";
      if (briefHash !== inputFingerprint) continue;
    }
    const finished = events.some((candidate) =>
      candidate.toolCallId === event.toolCallId && candidate.type === "tool_call.completed");
    if (!finished) count += 1;
  }
  return count;
}

export function interruptionEventsFromUiMessages(messages: UIMessage[]): NewLoopBuildEvent[] {
  return messages.flatMap((message) => (message.parts ?? []).flatMap((rawPart) => {
    const part = rawPart as { type: string; toolName?: string; toolCallId?: string; state?: string; input?: unknown };
    if (!part.toolCallId || !["input-streaming", "input-available"].includes(part.state ?? "")) return [];
    const name = toolName(part);
    const resumable = HUMAN_INPUT_TOOLS.has(name) && part.input !== undefined;
    const payload = {
      messageId: message.id,
      toolName: name,
      desiredState: resumable ? "input-available" : "output-error",
      errorText: resumable ? undefined : "Tool execution was interrupted before completion",
    };
    return [{
      eventKey: `tool:${part.toolCallId}:aborted:${eventPayloadHash(payload)}`,
      type: "tool_call.interrupted" as const,
      toolCallId: part.toolCallId,
      payload,
    }];
  }));
}

/** Persist interruption facts for tool calls superseded before completion. */
export function interruptionEventsForToolCallIds(
  messages: UIMessage[],
  toolCallIds: string[],
): NewLoopBuildEvent[] {
  if (toolCallIds.length === 0) return [];
  const idSet = new Set(toolCallIds);
  return messages.flatMap((message) => (message.parts ?? []).flatMap((rawPart) => {
    const part = rawPart as {
      type: string;
      toolName?: string;
      toolCallId?: string;
      state?: string;
      input?: unknown;
    };
    if (!part.toolCallId || !idSet.has(part.toolCallId)) return [];
    const name = toolName(part);
    const resumable = HUMAN_INPUT_TOOLS.has(name) && part.input !== undefined;
    const payload = {
      messageId: message.id,
      toolName: name,
      desiredState: "output-error" as const,
      errorText: resumable
        ? "Superseded by a later user message before this prompt was answered."
        : "Tool execution was interrupted before completion",
    };
    return [{
      eventKey: `tool:${part.toolCallId}:superseded:${eventPayloadHash(payload)}`,
      type: "tool_call.interrupted" as const,
      toolCallId: part.toolCallId,
      payload,
    }];
  }));
}

function fromRow(row: LoopBuildEventRow): LoopBuildEvent {
  return {
    id: row.id,
    loopId: row.loop_id,
    threadKind: row.thread_kind,
    runId: row.run_id,
    sequence: Number(row.sequence),
    eventKey: row.event_key,
    type: row.event_type,
    payload: row.payload,
    toolCallId: row.tool_call_id,
    createdAt: row.created_at,
  };
}

/** Caller must hold the loop row lock when multiple writers may append concurrently. */
export async function appendLoopBuildEventsWithClient(input: {
  client: Queryable;
  loopId: string;
  threadKind?: "build" | "run";
  runId?: string | null;
  events: NewLoopBuildEvent[];
}): Promise<LoopBuildEvent[]> {
  if (input.events.length === 0) return [];
  const threadKind = input.threadKind ?? "build";
  const runId = input.runId ?? null;
  const result = await input.client.query<LoopBuildEventRow>(
    `WITH raw_events AS (
       SELECT value, ordinality
       FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY
     ), candidates AS (
       SELECT DISTINCT ON (value->>'eventKey') value, ordinality
       FROM raw_events
       WHERE NOT EXISTS (
         SELECT 1 FROM loop_build_events existing
         WHERE existing.loop_id = $1
           AND existing.thread_kind = $2
           AND existing.run_id IS NOT DISTINCT FROM $3
           AND existing.event_key = value->>'eventKey'
       )
       ORDER BY value->>'eventKey', ordinality
     ), numbered AS (
       SELECT value, ROW_NUMBER() OVER (ORDER BY ordinality) - 1 AS sequence_offset
       FROM candidates
     ), base AS (
       SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM loop_build_events
       WHERE loop_id = $1 AND thread_kind = $2 AND run_id IS NOT DISTINCT FROM $3
     )
     INSERT INTO loop_build_events
       (id, loop_id, thread_kind, run_id, sequence, event_key, event_type, payload, tool_call_id)
     SELECT gen_random_uuid(), $1, $2, $3, base.next_sequence + numbered.sequence_offset,
            numbered.value->>'eventKey', numbered.value->>'type', numbered.value->'payload',
            NULLIF(numbered.value->>'toolCallId', '')
     FROM numbered CROSS JOIN base
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.loopId, threadKind, runId, JSON.stringify(input.events.map((event) => ({
      eventKey: event.eventKey,
      type: event.type,
      payload: event.payload,
      toolCallId: event.toolCallId ?? "",
    })))],
  );
  return result.rows.map(fromRow).sort((left, right) => left.sequence - right.sequence);
}

export async function listAuthorizedBuildEvents(
  client: Queryable,
  input: { loopId: string; tenantId: string; userId: string },
): Promise<LoopBuildEvent[]> {
  const result = await client.query<LoopBuildEventRow>(
    `SELECT event.*
     FROM loop_build_events event
     INNER JOIN loops loop ON loop.id = event.loop_id
     WHERE event.loop_id = $1
       AND event.thread_kind = 'build'
       AND event.run_id IS NULL
       AND loop.tenant_id = $2
       AND loop.user_id = $3
     ORDER BY event.sequence ASC`,
    [input.loopId, input.tenantId, input.userId],
  );
  return result.rows.map(fromRow);
}

export async function listAuthorizedRunEvents(
  client: Queryable,
  input: { loopId: string; runId: string; tenantId: string; userId: string },
): Promise<LoopBuildEvent[]> {
  const result = await client.query<LoopBuildEventRow>(
    `SELECT event.*
     FROM loop_build_events event
     INNER JOIN loops loop ON loop.id = event.loop_id
     INNER JOIN loop_runs run ON run.id = event.run_id AND run.loop_id = event.loop_id
     WHERE event.loop_id = $1
       AND event.thread_kind = 'run'
       AND event.run_id = $2
       AND loop.tenant_id = $3
       AND loop.user_id = $4
     ORDER BY event.sequence ASC`,
    [input.loopId, input.runId, input.tenantId, input.userId],
  );
  return result.rows.map(fromRow);
}

export async function getLatestArtifactEvent(
  client: Queryable,
  loopId: string,
): Promise<LoopBuildEvent | null> {
  const result = await client.query<LoopBuildEventRow>(
    `SELECT * FROM loop_build_events
     WHERE loop_id = $1 AND thread_kind = 'build' AND run_id IS NULL
       AND event_type IN ('artifact.committed', 'phase.recovery_requested')
     ORDER BY sequence DESC
     LIMIT 1`,
    [loopId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export function getConductorExecutionMetadata(
  event: Pick<LoopBuildEvent, "type" | "payload">,
): ConductorExecutionMetadata | null {
  if (event.type !== "tool_call.completed" && event.type !== "tool_call.errored") return null;
  return readConductorExecutionMetadata(event.payload);
}

function matchesOperationLookup(
  metadata: ConductorExecutionMetadata,
  lookup: ConductorOperationLookup,
): boolean {
  return metadata.operationKey === lookup.operationKey
    && (lookup.parentArtifactHash == null || metadata.parentArtifactHash === lookup.parentArtifactHash);
}

export function findConductorOperationEvents(
  events: LoopBuildEvent[],
  lookup: ConductorOperationLookup,
): Array<LoopBuildEvent & { metadata: ConductorExecutionMetadata }> {
  return events.flatMap((event) => {
    const metadata = getConductorExecutionMetadata(event);
    if (!metadata || !matchesOperationLookup(metadata, lookup)) return [];
    return [{ ...event, metadata }];
  });
}

export function getLatestConductorOperationAttempt(
  events: LoopBuildEvent[],
  lookup: ConductorOperationLookup,
): (LoopBuildEvent & { metadata: ConductorExecutionMetadata }) | null {
  const matches = findConductorOperationEvents(events, lookup);
  return matches.at(-1) ?? null;
}

export function hasCompletedConductorOperation(
  events: LoopBuildEvent[],
  lookup: ConductorOperationLookup,
): boolean {
  return findConductorOperationEvents(events, lookup).length > 0;
}

export function hasFailedConductorOperation(
  events: LoopBuildEvent[],
  lookup: ConductorOperationLookup,
): boolean {
  const latest = getLatestConductorOperationAttempt(events, lookup);
  return latest?.metadata.ok === false;
}

export function isTerminalConductorExecution(metadata: ConductorExecutionMetadata): boolean {
  if (isRecoverableConductorExecution(metadata)) return false;
  return metadata.requiresUserInput
    || metadata.phaseCompleted
    || (metadata.ok === false && metadata.retryAllowed === false);
}

export function hasTerminalConductorPhaseResult(
  events: LoopBuildEvent[],
  input: { phase: ConductorExecutionMetadata["phaseBefore"]; parentArtifactHash: string },
): boolean {
  return events.some((event) => {
    const metadata = getConductorExecutionMetadata(event);
    return Boolean(metadata
      && metadata.phaseBefore === input.phase
      && metadata.parentArtifactHash === input.parentArtifactHash
      && isTerminalConductorExecution(metadata));
  });
}

export function eventsForConductorPhaseAttempt(
  events: LoopBuildEvent[],
  input: { phase: ConductorExecutionMetadata["phaseBefore"]; parentArtifactHash: string },
): LoopBuildEvent[] {
  const recoverySequence = events
    .filter((event) => event.type === "phase.recovery_requested"
      && event.payload.recoveryPhase === input.phase
      && event.payload.parentArtifactHash === input.parentArtifactHash)
    .at(-1)?.sequence;
  return recoverySequence == null
    ? events
    : events.filter((event) => event.sequence > recoverySequence);
}

export function makeConductorPhaseTurnEvent(
  payload: ConductorPhaseTurnPayload,
): NewLoopBuildEvent {
  return {
    eventKey: `phase-turn:${payload.phase}:${payload.parentArtifactHash}:${eventPayloadHash(payload)}`,
    type: "phase_turn.completed",
    payload,
  };
}

/** Persist server-executed tool evidence for dedup and projection during a Conductor turn. */
export function makeConductorToolCompletedEvent(input: {
  toolName: string;
  input: unknown;
  output: Record<string, unknown>;
  toolCallId?: string;
  messageId?: string;
}): NewLoopBuildEvent {
  const metadata = readConductorExecutionMetadata(input.output);
  const operationKey = typeof metadata?.operationKey === "string" ? metadata.operationKey : input.toolName;
  const stepsUsed = metadata?.stepsUsed ?? 0;
  const toolCallId = input.toolCallId ?? `server:${operationKey}:${stepsUsed}`;
  const payload = {
    messageId: input.messageId ?? `server:${toolCallId}`,
    toolName: input.toolName,
    state: "output-available",
    input: input.input,
    output: input.output,
    ...metadata,
  };
  return {
    eventKey: `tool-exec:${operationKey}:${stepsUsed}`,
    type: "tool_call.completed",
    toolCallId,
    payload,
  };
}

export type ConductorPhaseRecoveryPayload = {
  sourcePhase: string;
  recoveryPhase: string;
  parentArtifactHash: string;
  artifactRevision?: string;
  reason: string;
  invalidatedPhases: string[];
  continuation: "next_phase";
  handoffId?: string;
  state: Record<string, unknown>;
};

/** Rebuild the persisted transcript without mutating or repairing stored message state. */
export function projectChatMessages(events: LoopBuildEvent[]): UIMessage[] {
  const messages = new Map<string, { firstSequence: number; message: UIMessage }>();
  for (const event of events) {
    if (event.type !== "message.appended") continue;
    const message = event.payload.message as UIMessage | undefined;
    if (!message?.id || !message.role) continue;
    const previous = messages.get(message.id);
    messages.set(message.id, {
      firstSequence: previous?.firstSequence ?? event.sequence,
      message,
    });
  }
  const projected = [...messages.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map((entry) => entry.message);
  const lifecycle = new Map<string, LoopBuildEvent>();
  for (const event of events) {
    if (event.toolCallId && event.payload.desiredState) lifecycle.set(event.toolCallId, event);
  }
  return projected.map((message) => ({
    ...message,
    parts: (message.parts ?? []).map((rawPart) => {
      const part = rawPart as { toolCallId?: string; state?: string };
      const event = part.toolCallId ? lifecycle.get(part.toolCallId) : undefined;
      const desiredState = event?.payload.desiredState;
      if (desiredState === "input-available") return { ...rawPart, state: "input-available" } as UIMessage["parts"][number];
      if (desiredState === "output-error") return {
        ...rawPart,
        state: "output-error",
        output: { interrupted: true },
        errorText: event?.payload.errorText,
      } as unknown as UIMessage["parts"][number];
      return rawPart;
    }),
  }));
}

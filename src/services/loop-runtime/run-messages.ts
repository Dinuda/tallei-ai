import { getToolName, isToolUIPart, type UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { mergePartsForStep } from "./run-tool-merge.js";

function isDataAgentPart(part: unknown): part is { type: "data-agent"; data: { stepIndex?: number } } {
  return typeof part === "object" && part !== null
    && (part as { type?: string }).type === "data-agent";
}

function isReasoningLikePart(part: UIMessage["parts"][number]): boolean {
  return part.type === "reasoning" || part.type.startsWith("reasoning-");
}

const GATE_TOOL_NAMES = new Set(["requestReview", "requestApproval", "requestInput"]);

function stepHasRenderableOutput(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => {
    if (!isToolUIPart(part)) return false;
    const toolName = getToolName(part);
    if (toolName === "finalizeAgent" && part.state === "output-available") return true;
    if (GATE_TOOL_NAMES.has(toolName) && (part.state === "output-available" || part.state === "output-error")) {
      return true;
    }
    return false;
  });
}

/** Drop freeform narration when a step already has a renderable tool/artifact outcome. */
export function sanitizeSpecRunAgentParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  if (!stepHasRenderableOutput(parts)) return parts;
  return parts.filter((part) => part.type !== "text" && !isReasoningLikePart(part));
}

export function sanitizeSpecRunMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.parts.some(isDataAgentPart)) return message;
    return {
      ...message,
      parts: sanitizeSpecRunAgentParts(message.parts),
    };
  });
}

/** Drop stale narration for a step before retrying it (e.g. after operator revise). */
export function pruneStepNarrationForStep(messages: UIMessage[], stepIndex: number): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];

    let activeStepIndex: number | null = null;
    const parts: UIMessage["parts"] = [];

    for (const part of message.parts) {
      if (isDataAgentPart(part) && typeof part.data.stepIndex === "number") {
        activeStepIndex = part.data.stepIndex;
        parts.push(part);
        continue;
      }
      if (activeStepIndex === stepIndex && (part.type === "text" || isReasoningLikePart(part))) {
        continue;
      }
      parts.push(part);
    }

    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

export function mergeRunChatMessages(server: UIMessage[], client: UIMessage[]): UIMessage[] {
  const serverIds = new Set(server.map((message) => message.id));
  const trailingClient = client.filter((message) => !serverIds.has(message.id));
  return normalizeRunMessages([...server, ...trailingClient]);
}

function getAgentStepIndex(part: unknown): number | undefined {
  if (typeof part !== "object" || !part) return undefined;
  const p = part as Record<string, unknown>;
  if (p.type !== "data-agent") return undefined;
  const data = p.data;
  if (typeof data !== "object" || !data) return undefined;
  const stepIndex = (data as Record<string, unknown>).stepIndex;
  return typeof stepIndex === "number" ? stepIndex : undefined;
}

function messageStepIndex(message: UIMessage): number | undefined {
  if (message.role !== "assistant") return undefined;
  for (const part of message.parts) {
    const stepIndex = getAgentStepIndex(part);
    if (stepIndex !== undefined) return stepIndex;
  }
  return undefined;
}

function dedupeAgentMessagesByStepIndex(messages: UIMessage[]): UIMessage[] {
  const stepBuckets = new Map<number, UIMessage[]>();

  for (const message of messages) {
    const stepIndex = messageStepIndex(message);
    if (stepIndex === undefined) continue;
    const bucket = stepBuckets.get(stepIndex) ?? [];
    bucket.push(message);
    stepBuckets.set(stepIndex, bucket);
  }

  const mergedByStep = new Map<number, UIMessage>();
  for (const [stepIndex, bucket] of stepBuckets) {
    const last = bucket[bucket.length - 1]!;
    mergedByStep.set(stepIndex, {
      ...last,
      id: last.id || `step-${stepIndex}`,
      parts: mergePartsForStep(bucket),
    });
  }

  const seenSteps = new Set<number>();
  const ordered: UIMessage[] = [];
  for (const message of messages) {
    const stepIndex = messageStepIndex(message);
    if (stepIndex === undefined) {
      ordered.push(message);
      continue;
    }
    if (seenSteps.has(stepIndex)) continue;
    seenSteps.add(stepIndex);
    ordered.push(mergedByStep.get(stepIndex)!);
  }

  return ordered;
}

export function normalizeRunMessages(messages: unknown[]): UIMessage[] {
  const normalized = messages.filter((message): message is UIMessage =>
    Boolean(message && typeof message === "object" && "role" in message && "parts" in message));

  const seen = new Set<string>();
  const deduped = normalized
    .filter((message) => Array.isArray(message.parts) && message.parts.length > 0)
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  return dedupeAgentMessagesByStepIndex(deduped);
}

export async function listLoopRunMessages(auth: AuthContext, runId: string): Promise<UIMessage[]> {
  const result = await pool.query<{ message_json: unknown }>(
    `SELECT message_json
     FROM loop_run_messages
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY sequence ASC`,
    [runId, auth.tenantId, auth.userId],
  );
  return normalizeRunMessages(result.rows.map((row) => row.message_json));
}

export async function replaceLoopRunMessages(auth: AuthContext, runId: string, messages: UIMessage[]): Promise<void> {
  const normalizedMessages = sanitizeSpecRunMessages(normalizeRunMessages(messages));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM loop_run_messages WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3`,
      [runId, auth.tenantId, auth.userId],
    );
    for (const message of normalizedMessages) {
      await client.query(
        `INSERT INTO loop_run_messages (run_id, tenant_id, user_id, message_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [runId, auth.tenantId, auth.userId, JSON.stringify(message)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Max Gmail messages kept in run history / planner context (latest by timestamp). */
export const RUNTIME_EMAIL_MESSAGE_LIMIT = 2;

const PLANNER_STEP_HISTORY_MAX_SERIALIZED = 24_000;
const PLANNER_MESSAGE_TEXT_MAX = 600;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function emailMessageSortKey(msg: unknown): number {
  const m = asRecord(msg);
  if (!m) return 0;
  const ts = m.messageTimestamp ?? m.internalDate ?? m.date;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function takeLatestEmailMessages(
  messages: unknown[],
  limit = RUNTIME_EMAIL_MESSAGE_LIMIT,
): unknown[] {
  if (messages.length <= limit) return messages;
  return [...messages]
    .sort((a, b) => emailMessageSortKey(b) - emailMessageSortKey(a))
    .slice(0, limit);
}

function compactEmailMessage(msg: unknown): Record<string, unknown> {
  const m = asRecord(msg);
  if (!m) return { _compact: true, value: String(msg).slice(0, 200) };
  const preview = asRecord(m.preview);
  const text = typeof m.messageText === "string" ? m.messageText : undefined;
  const previewBody = typeof preview?.body === "string" ? preview.body : undefined;
  return {
    messageId: m.messageId ?? m.id,
    threadId: m.threadId,
    subject: m.subject ?? preview?.subject,
    sender: m.sender ?? preview?.from,
    messageTimestamp: m.messageTimestamp ?? m.internalDate,
    labelIds: m.labelIds,
    snippet: text
      ? text.slice(0, PLANNER_MESSAGE_TEXT_MAX)
      : previewBody?.slice(0, PLANNER_MESSAGE_TEXT_MAX),
  };
}

/** Trim Gmail read payloads to the latest N messages with compact fields (no MIME blobs). */
export function compactEmailReadToolResult(result: unknown): unknown {
  const row = asRecord(result);
  if (!row) return result;

  const data = asRecord(row.data);
  const messages = data?.messages;
  if (Array.isArray(messages)) {
    const originalCount = messages.length;
    const latest = takeLatestEmailMessages(messages);
    return {
      ...row,
      data: {
        ...data,
        messages: latest.map(compactEmailMessage),
        ...(originalCount > latest.length
          ? { _runtimeNote: `Showing latest ${latest.length} of ${originalCount} message(s)` }
          : {}),
      },
    };
  }

  const serialized = JSON.stringify(result);
  if (serialized.length <= PLANNER_STEP_HISTORY_MAX_SERIALIZED) return result;
  return {
    _truncated: true,
    originalBytes: serialized.length,
    preview: serialized.slice(0, PLANNER_STEP_HISTORY_MAX_SERIALIZED),
  };
}

/** Shrink prior tool outputs before embedding in planner prompts. */
export function compactStepHistoryForPlanner(stepHistory: unknown[]): unknown[] {
  return stepHistory.map((entry) => {
    const row = asRecord(entry);
    if (!row) return entry;
    if ("result" in row) {
      return { ...row, result: compactEmailReadToolResult(row.result) };
    }
    return compactEmailReadToolResult(entry);
  });
}

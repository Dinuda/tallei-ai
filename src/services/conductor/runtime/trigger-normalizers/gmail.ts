import { createHash } from "crypto";

export type NormalizedGmailTriggerTicket = {
  subject: string;
  body: string;
  fromName: string;
  fromEmail: string;
  messageId: string;
  threadId: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseEmailAddress(value: unknown): { name: string; email: string } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^>]+)>$/);
    if (match) {
      return { name: match[1]?.trim() ?? "", email: match[2]?.trim() ?? "" };
    }
    if (trimmed.includes("@")) return { name: "", email: trimmed };
    return { name: trimmed, email: "" };
  }
  const record = asObject(value);
  const email = readString(record.email ?? record.address);
  const name = readString(record.name ?? record.displayName);
  return { name, email };
}

export function normalizeGmailTriggerPayload(data: Record<string, unknown>): NormalizedGmailTriggerTicket | null {
  const nested = [
    data,
    asObject(data.message),
    asObject(data.payload),
    asObject(data.email),
    asObject(data.data),
  ];

  let subject = "";
  let body = "";
  let fromName = "";
  let fromEmail = "";
  let messageId = "";
  let threadId = "";

  for (const record of nested) {
    if (!subject) subject = readString(record.subject ?? record.title);
    if (!body) {
      body = readString(
        record.body
        ?? record.message_body
        ?? record.messageBody
        ?? record.message_text
        ?? record.messageText
        ?? record.snippet
        ?? record.text,
      );
    }
    if (!fromEmail || !fromName) {
      const parsed = parseEmailAddress(record.from ?? record.sender ?? record.from_email ?? record.fromEmail);
      if (!fromName && parsed.name) fromName = parsed.name;
      if (!fromEmail && parsed.email) fromEmail = parsed.email;
    }
    if (!messageId) {
      messageId = readString(record.message_id ?? record.messageId ?? record.id);
    }
    if (!threadId) {
      threadId = readString(record.thread_id ?? record.threadId);
    }
  }

  if (!body && !subject && !fromEmail) return null;

  return {
    subject,
    body,
    fromName,
    fromEmail,
    messageId,
    threadId,
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function gmailTriggerDedupeKey(data: Record<string, unknown>): string | null {
  const normalized = normalizeGmailTriggerPayload(data);
  if (!normalized) return null;
  if (normalized.messageId) return `gmail:message:${normalized.messageId}`;

  const fallbackParts = [
    normalized.threadId,
    normalized.fromEmail.toLowerCase(),
    normalized.subject.toLowerCase(),
    stableHash(normalized.body),
  ].filter(Boolean);
  if (fallbackParts.length === 0) return null;
  return `gmail:fallback:${stableHash(fallbackParts.join("\n"))}`;
}

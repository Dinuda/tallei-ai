import { createHmac, timingSafeEqual } from "crypto";

import { clearSessionCache } from "./session.js";
import { toObjectRecord } from "./client.js";
import { composioWebhookSecretsToTry } from "./webhook-subscription.js";

const COMPOSIO_WEBHOOK_TOLERANCE_SEC = 300;

export type ComposioWebhookSignatureHeaders = {
  webhookId?: string;
  webhookTimestamp?: string;
  webhookSignature?: string;
  legacySignature?: string;
};

export type ComposioAuthWebhookEvent = {
  kind: "auth_event";
  eventType: string;
};

export type ComposioTriggerWebhookEvent = {
  kind: "trigger_event";
  entityId: string;
  triggerSlug: string;
  externalEventId: string;
  payload: unknown;
};

export type NormalizedComposioWebhook =
  | ComposioAuthWebhookEvent
  | ComposioTriggerWebhookEvent
  | { kind: "ignored" };

function compareDigestStrings(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeWebhookTimestamp(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  // Composio/Svix may send seconds or milliseconds.
  return parsed > 1_000_000_000_000 ? Math.floor(parsed / 1000) : parsed;
}

function extractSignatureCandidates(header: string): string[] {
  return header
    .split(/\s+/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      if (trimmed.includes(",")) {
        const [, sig] = trimmed.split(",", 2);
        return sig?.trim() ? [sig.trim()] : [];
      }
      return [trimmed];
    })
    .filter(Boolean);
}

function verifyComposioSubscriptionWebhookSignatureWithSecret(
  rawBody: Buffer,
  headers: Required<Pick<ComposioWebhookSignatureHeaders, "webhookId" | "webhookTimestamp" | "webhookSignature">>,
  secret: string,
): "ok" | "invalid_timestamp" | "invalid_signature" {
  const timestamp = normalizeWebhookTimestamp(headers.webhookTimestamp);
  if (timestamp == null) return "invalid_timestamp";
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > COMPOSIO_WEBHOOK_TOLERANCE_SEC) return "invalid_timestamp";

  const signingString = `${headers.webhookId}.${headers.webhookTimestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(signingString).digest("base64");
  const candidates = extractSignatureCandidates(headers.webhookSignature);
  return candidates.some((received) => compareDigestStrings(expected, received)) ? "ok" : "invalid_signature";
}

function verifyLegacyComposioWebhookSignatureWithSecret(
  rawBody: Buffer,
  legacySignature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = legacySignature.replace(/^sha256=/i, "").trim();
  if (!provided) return false;
  return compareDigestStrings(expected, provided);
}

function verifyLegacyComposioWebhookSignature(rawBody: Buffer, legacySignature: string): boolean {
  return composioWebhookSecretsToTry().some((secret) =>
    verifyLegacyComposioWebhookSignatureWithSecret(rawBody, legacySignature, secret),
  );
}

export type WebhookSignatureVerification = {
  ok: boolean;
  reason?: "missing_secret" | "missing_body" | "missing_headers" | "invalid_timestamp" | "invalid_signature";
};

export function verifyComposioWebhookSignatureDetailed(
  rawBody: Buffer | undefined,
  headers: ComposioWebhookSignatureHeaders,
): WebhookSignatureVerification {
  if (!composioWebhookSecretsToTry().length) return { ok: false, reason: "missing_secret" };
  if (!rawBody) return { ok: false, reason: "missing_body" };

  const webhookId = headers.webhookId?.trim();
  const webhookTimestamp = headers.webhookTimestamp?.trim();
  const webhookSignature = headers.webhookSignature?.trim();
  if (webhookId && webhookTimestamp && webhookSignature) {
    const requiredHeaders = { webhookId, webhookTimestamp, webhookSignature };
    let sawInvalidSignature = false;
    for (const secret of composioWebhookSecretsToTry()) {
      const result = verifyComposioSubscriptionWebhookSignatureWithSecret(rawBody, requiredHeaders, secret);
      if (result === "ok") return { ok: true };
      if (result === "invalid_signature") sawInvalidSignature = true;
      if (result === "invalid_timestamp") return { ok: false, reason: "invalid_timestamp" };
    }
    return { ok: false, reason: sawInvalidSignature ? "invalid_signature" : "invalid_timestamp" };
  }

  const legacySignature = headers.legacySignature?.trim();
  if (legacySignature) {
    return verifyLegacyComposioWebhookSignature(rawBody, legacySignature)
      ? { ok: true }
      : { ok: false, reason: "invalid_signature" };
  }

  return { ok: false, reason: "missing_headers" };
}

export function verifyComposioWebhookSignature(
  rawBody: Buffer | undefined,
  headers: ComposioWebhookSignatureHeaders,
): boolean {
  return verifyComposioWebhookSignatureDetailed(rawBody, headers).ok;
}

export function normalizeComposioWebhookPayload(payload: unknown): NormalizedComposioWebhook {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "ignored" };
  const event = payload as Record<string, unknown>;
  const eventType = typeof event.type === "string"
    ? event.type
    : typeof event.event === "string"
      ? event.event
      : "";

  if (eventType.includes("connected_account") || eventType.includes("connection")) {
    return { kind: "auth_event", eventType };
  }

  // Composio V3: metadata at envelope root; event body in `data`.
  const envelopeMetadata = toObjectRecord(event.metadata);
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : event;
  const nestedMetadata = data.metadata && typeof data.metadata === "object"
    ? data.metadata as Record<string, unknown>
    : {};
  const metadata = { ...envelopeMetadata, ...nestedMetadata };

  const triggerSlug = String(
    metadata.trigger_slug
    ?? metadata.triggerSlug
    ?? data.triggerName
    ?? data.trigger_slug
    ?? event.trigger_name
    ?? "",
  ).trim();

  const entityId = String(
    metadata.user_id
    ?? metadata.userId
    ?? data.entityId
    ?? data.entity_id
    ?? data.user_id
    ?? data.userId
    ?? event.entityId
    ?? "",
  ).trim();

  if (!triggerSlug || !entityId) {
    if (eventType.includes("connected") || eventType.includes("revoked")) {
      return { kind: "auth_event", eventType };
    }
    return { kind: "ignored" };
  }

  const externalEventId = String(
    event.id
    ?? data.id
    ?? metadata.log_id
    ?? metadata.trigger_id
    ?? `${triggerSlug}:${Date.now()}`,
  ).trim();

  const eventPayload = eventType === "composio.trigger.message" && event.data
    ? { ...metadata, payload: event.data }
    : data;

  return {
    kind: "trigger_event",
    entityId,
    triggerSlug,
    externalEventId,
    payload: eventPayload,
  };
}

export function handleComposioAuthWebhook(eventType: string): { ok: true; kind: "auth"; processed: boolean } {
  if (eventType.includes("connected") || eventType.includes("revoked") || eventType.includes("connection")) {
    clearSessionCache();
    return { ok: true, kind: "auth", processed: true };
  }
  return { ok: true, kind: "auth", processed: false };
}

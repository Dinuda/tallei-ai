import { createHmac, timingSafeEqual } from "crypto";

import { config } from "../../config/index.js";
import { clearSessionCache } from "./session.js";
import { toObjectRecord } from "./client.js";

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

function verifyComposioSubscriptionWebhookSignature(
  rawBody: Buffer,
  headers: Required<Pick<ComposioWebhookSignatureHeaders, "webhookId" | "webhookTimestamp" | "webhookSignature">>,
): boolean {
  const timestamp = Number.parseInt(headers.webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > COMPOSIO_WEBHOOK_TOLERANCE_SEC) return false;

  const signingString = `${headers.webhookId}.${headers.webhookTimestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", config.composioWebhookSecret).update(signingString).digest("base64");
  const received = headers.webhookSignature.includes(",")
    ? headers.webhookSignature.split(",", 2)[1]?.trim() ?? ""
    : headers.webhookSignature.trim();
  if (!received) return false;
  return compareDigestStrings(expected, received);
}

function verifyLegacyComposioWebhookSignature(rawBody: Buffer, legacySignature: string): boolean {
  const expected = createHmac("sha256", config.composioWebhookSecret).update(rawBody).digest("hex");
  const provided = legacySignature.replace(/^sha256=/i, "").trim();
  if (!provided) return false;
  return compareDigestStrings(expected, provided);
}

export function verifyComposioWebhookSignature(
  rawBody: Buffer | undefined,
  headers: ComposioWebhookSignatureHeaders,
): boolean {
  if (!config.composioWebhookSecret) return false;
  if (!rawBody) return false;

  const webhookId = headers.webhookId?.trim();
  const webhookTimestamp = headers.webhookTimestamp?.trim();
  const webhookSignature = headers.webhookSignature?.trim();
  if (webhookId && webhookTimestamp && webhookSignature) {
    return verifyComposioSubscriptionWebhookSignature(rawBody, {
      webhookId,
      webhookTimestamp,
      webhookSignature,
    });
  }

  const legacySignature = headers.legacySignature?.trim();
  if (legacySignature) return verifyLegacyComposioWebhookSignature(rawBody, legacySignature);

  return false;
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

  const data = event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : event;
  const metadata = data.metadata && typeof data.metadata === "object"
    ? data.metadata as Record<string, unknown>
    : toObjectRecord(event.metadata);

  const triggerSlug = String(
    metadata.trigger_slug ?? metadata.triggerSlug ?? data.triggerName ?? data.trigger_slug ?? "",
  ).trim();

  const entityId = String(
    data.entityId ?? data.entity_id ?? data.user_id ?? data.userId ?? event.entityId ?? "",
  ).trim();

  if (!triggerSlug || !entityId) {
    if (eventType.includes("connected") || eventType.includes("revoked")) {
      return { kind: "auth_event", eventType };
    }
    return { kind: "ignored" };
  }

  const externalEventId = String(
    data.id ?? event.id ?? metadata.trigger_id ?? `${triggerSlug}:${Date.now()}`,
  ).trim();

  return {
    kind: "trigger_event",
    entityId,
    triggerSlug,
    externalEventId,
    payload: data,
  };
}

export function handleComposioAuthWebhook(eventType: string): { ok: true; kind: "auth"; processed: boolean } {
  if (eventType.includes("connected") || eventType.includes("revoked") || eventType.includes("connection")) {
    clearSessionCache();
    return { ok: true, kind: "auth", processed: true };
  }
  return { ok: true, kind: "auth", processed: false };
}

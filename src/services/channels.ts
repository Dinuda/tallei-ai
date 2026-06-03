import { createHash, randomUUID } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { getUserById } from "../infrastructure/auth/auth.js";
import { encryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { pool } from "../infrastructure/db/index.js";
import { sendResendEmail } from "./notifications/resend-email.js";

export type NotificationChannelKind = "email" | "gmail" | "whatsapp" | "telegram";
type ManagedChannelKind = "email" | "gmail" | "telegram";
export type ChannelSetupMode = "default" | "botfather" | "shared" | "session";
export type ChannelSetupStatus = "pending" | "connected" | "expired" | "failed";
export type ApprovalTargetType = "workflow_suggestion" | "workflow_run" | "workflow_gate";

export interface NotificationChannelConfig {
  kind: NotificationChannelKind;
  destination: string;
  id: string;
  isPrimary: boolean;
  label: string | null;
  config: Record<string, unknown>;
}

export interface NotificationChannelView {
  id: string;
  kind: NotificationChannelKind;
  destination: string;
  enabled: boolean;
  isPrimary: boolean;
  status: string;
  label: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSetupSessionView {
  id: string;
  kind: NotificationChannelKind;
  mode: ChannelSetupMode;
  status: ChannelSetupStatus;
  expiresAt: string;
  nonce: string | null;
  pairingCode: string | null;
  deepLinkUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface ChannelMessageView {
  id: string;
  channelId: string;
  kind: NotificationChannelKind;
  direction: "inbound" | "outbound";
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ChannelsOverview {
  channels: NotificationChannelView[];
  messages: ChannelMessageView[];
}

export interface ApprovalPromptInput {
  auth: AuthContext;
  channel: NotificationChannelConfig;
  targetType: ApprovalTargetType;
  targetId: string;
  approvalUrl: string;
  approvalToken: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  draftOutput?: string | null;
}

export interface StatusNotificationInput {
  auth: AuthContext;
  title: string;
  body: string;
  channel?: NotificationChannelConfig | null;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunApprovalPromptInput {
  auth: AuthContext;
  runId: string;
  workflowId: string;
  workflowTitle: string;
  artifactBody: string;
  approvalUrl: string;
  approvalToken: string;
  artifactKind?: string | null;
}

export interface WorkflowRunApprovalPromptResult {
  to: string;
  sentAt: string;
  channel?: NotificationChannelKind;
}

export interface DeliveryResult {
  ok: boolean;
  provider: string;
  externalMessageId?: string;
  error?: string;
}

export interface InboundChannelAction {
  type: "approve" | "skip" | "gate_input" | "message" | "none";
  tenantId?: string;
  userId?: string;
  channel?: NotificationChannelKind;
  token?: string;
  runId?: string;
  gateId?: string;
  value?: string;
  body?: string;
}

interface ChannelRow {
  id: string;
  kind: string;
  destination: string;
  enabled: boolean;
  is_primary: boolean;
  status: string;
  label: string | null;
  verified_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  config_json: unknown;
  created_at: string;
  updated_at: string;
}

interface ChannelSetupRow {
  id: string;
  kind: string;
  mode: string;
  status: string;
  nonce: string | null;
  pairing_code: string | null;
  expires_at: string;
  metadata_json: unknown;
}

interface ChannelMessageRow {
  id: string;
  channel_id: string;
  kind: string;
  direction: "inbound" | "outbound";
  body: string;
  metadata_json: unknown;
  created_at: string;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asChannelKind(value: string): NotificationChannelKind | null {
  if (value === "email" || value === "gmail" || value === "whatsapp" || value === "telegram") {
    return value;
  }
  return null;
}

function isManagedChannelKind(value: NotificationChannelKind): value is ManagedChannelKind {
  return value === "email" || value === "gmail" || value === "telegram";
}

function parseChannelRow(row: ChannelRow): NotificationChannelView {
  const kind = asChannelKind(row.kind);
  if (!kind) {
    throw new Error(`Unsupported notification channel kind: ${row.kind}`);
  }
  const fallbackTimestamp = new Date(0).toISOString();
  return {
    id: row.id ?? randomUUID(),
    kind,
    destination: row.destination,
    enabled: row.enabled ?? true,
    isPrimary: row.is_primary ?? false,
    status: row.status ?? "connected",
    label: row.label,
    verifiedAt: row.verified_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    config: readObject(row.config_json),
    createdAt: row.created_at ?? fallbackTimestamp,
    updatedAt: row.updated_at ?? fallbackTimestamp,
  };
}

function parseSetupRow(row: ChannelSetupRow): ChannelSetupSessionView {
  const kind = asChannelKind(row.kind);
  if (!kind) {
    throw new Error(`Unsupported notification channel kind: ${row.kind}`);
  }
  const metadata = readObject(row.metadata_json);
  return {
    id: row.id,
    kind,
    mode: (row.mode === "botfather" ? "botfather" : row.mode === "shared" ? "shared" : row.mode === "session" ? "session" : "default"),
    status: row.status === "connected" ? "connected" : row.status === "expired" ? "expired" : row.status === "failed" ? "failed" : "pending",
    expiresAt: row.expires_at,
    nonce: row.nonce,
    pairingCode: row.pairing_code,
    deepLinkUrl: typeof metadata.deepLinkUrl === "string" ? metadata.deepLinkUrl : null,
    metadata,
  };
}

function isEnabledChannel(row: NotificationChannelView): row is NotificationChannelView {
  return row.enabled && (row.status === "connected" || row.status === "verified");
}

function channelMessageText(input: {
  title: string;
  reason: string;
  approvalUrl?: string;
  draftOutput?: string | null;
  suggestedPrompt?: string | null;
  footer?: string | null;
}): string {
  return [
    input.title,
    "",
    input.reason,
    input.draftOutput?.trim() || input.suggestedPrompt?.trim() || "",
    input.approvalUrl ? `Approve: ${input.approvalUrl}` : "",
    input.footer?.trim() || "",
  ].filter((line) => line.trim().length > 0).join("\n\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  }[char] ?? char));
}

function buildReplyAddress(channelId: string): string | null {
  const domain = config.channelsResendInboundDomain.trim();
  if (!domain) return null;
  return `reply+${channelId}@${domain}`;
}

function buildTelegramDeepLink(token: string, botUsername: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;
}

function buildWhatsAppDeepLink(pairingCode: string): string | null {
  const sharedNumber = config.channelsWhatsAppSharedNumber.trim().replace(/[^\d]/g, "");
  if (!sharedNumber) return null;
  return `https://wa.me/${sharedNumber}?text=${encodeURIComponent(`PAIR ${pairingCode}`)}`;
}

function makeSetupNonce(kind: NotificationChannelKind): string {
  return `${kind}_${createHash("sha256").update(`${kind}:${randomUUID()}:${Date.now()}`).digest("hex").slice(0, 24)}`;
}

function makePairingCode(): string {
  return createHash("sha256").update(`${randomUUID()}:${Date.now()}`).digest("hex").slice(0, 8).toUpperCase();
}

async function recordNotificationDeliveryAttempt(input: {
  auth: AuthContext;
  channel: NotificationChannelKind;
  targetType: ApprovalTargetType | "channel_test" | "loop_status";
  targetId: string;
  status: "queued" | "sent" | "failed";
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO notification_deliveries
     (id, tenant_id, user_id, channel, target_type, target_id, status, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.channel,
      input.targetType,
      input.targetId,
      input.status,
      JSON.stringify(input.payload),
    ]
  );
}

async function recordChannelMessage(input: {
  auth: AuthContext;
  channelId: string;
  channelKind: NotificationChannelKind;
  direction: "inbound" | "outbound";
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO channel_messages
     (id, tenant_id, user_id, channel_id, kind, direction, body, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      id,
      input.auth.tenantId,
      input.auth.userId,
      input.channelId,
      input.channelKind,
      input.direction,
      input.body,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return id;
}

async function upsertNotificationChannel(input: {
  auth: AuthContext;
  kind: NotificationChannelKind;
  destination: string;
  label?: string | null;
  status?: string;
  config?: Record<string, unknown>;
  verified?: boolean;
  enable?: boolean;
  primary?: boolean;
}): Promise<NotificationChannelView> {
  const status = input.status ?? "connected";
  const result = await pool.query<ChannelRow>(
    `INSERT INTO notification_channels
     (id, tenant_id, user_id, kind, destination, enabled, is_primary, status, label, verified_at, config_json)
     VALUES (
       $1, $2, $3, $4, $5, COALESCE($6, TRUE), COALESCE($11, FALSE), $7, $8,
       CASE WHEN $9 THEN NOW() ELSE NULL END,
       $10::jsonb
     )
     ON CONFLICT (tenant_id, user_id, kind, destination)
     DO UPDATE SET
       enabled = COALESCE($6, notification_channels.enabled),
       is_primary = CASE
         WHEN $11 IS NULL THEN notification_channels.is_primary
         ELSE $11
       END,
       status = EXCLUDED.status,
       label = COALESCE(EXCLUDED.label, notification_channels.label),
       verified_at = CASE
         WHEN $9 THEN NOW()
         ELSE notification_channels.verified_at
       END,
       last_error = NULL,
       last_error_at = NULL,
      config_json = notification_channels.config_json || EXCLUDED.config_json,
      updated_at = NOW()
     RETURNING id, kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.kind,
      input.destination,
      input.enable ?? true,
      status,
      input.label ?? null,
      input.verified ?? false,
      JSON.stringify(input.config ?? {}),
      input.primary ?? null,
    ]
  );
  return parseChannelRow(result.rows[0]);
}

async function ensureDefaultGmailChannel(auth: AuthContext): Promise<NotificationChannelView | null> {
  const existing = await pool.query<ChannelRow>(
    `SELECT id
            , kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
     FROM notification_channels
     WHERE tenant_id = $1
       AND user_id = $2
       AND enabled = TRUE
       AND status IN ('connected', 'verified')
       AND kind IN ('email', 'gmail', 'telegram')
     ORDER BY is_primary DESC, verified_at DESC NULLS LAST, created_at ASC
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );
  const existingChannel = existing.rows[0] ? parseChannelRow(existing.rows[0]) : null;
  if (existingChannel) {
    if (existingChannel.kind === "email" || existingChannel.kind === "gmail") {
      if (!existingChannel.isPrimary) {
        await pool.query(
          `UPDATE notification_channels
           SET is_primary = FALSE,
               updated_at = NOW()
           WHERE tenant_id = $1
             AND user_id = $2
             AND enabled = TRUE`,
          [auth.tenantId, auth.userId]
        );
        await pool.query(
          `UPDATE notification_channels
           SET is_primary = TRUE,
               updated_at = NOW()
           WHERE id = $1
             AND tenant_id = $2
             AND user_id = $3`,
          [existingChannel.id, auth.tenantId, auth.userId]
        );
      }
    }
    return null;
  }

  const user = await getUserById(auth.userId);
  const email = user?.email?.trim();
  if (!email) return null;

  await pool.query(
    `UPDATE notification_channels
     SET is_primary = FALSE,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2
       AND is_primary = TRUE`,
    [auth.tenantId, auth.userId]
  );

  return upsertNotificationChannel({
    auth,
    kind: "gmail",
    destination: email,
    label: "Signup inbox",
    verified: true,
    status: "connected",
    config: { provider: "resend", default: true },
    primary: true,
  });
}

async function lookupChannelById(auth: AuthContext, channelId: string): Promise<NotificationChannelView> {
  const result = await pool.query<ChannelRow>(
    `SELECT id, kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
     FROM notification_channels
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [channelId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Channel not found");
  }
  return parseChannelRow(row);
}

async function lookupChannelByDestination(kind: NotificationChannelKind, destination: string): Promise<{
  auth: AuthContext;
  channel: NotificationChannelView;
} | null> {
  const result = await pool.query<ChannelRow & { tenant_id: string; user_id: string }>(
    `SELECT id, tenant_id, user_id, kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
     FROM notification_channels
     WHERE kind = $1
       AND destination = $2
       AND enabled = TRUE
     ORDER BY is_primary DESC, updated_at DESC
     LIMIT 1`,
    [kind, destination]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    auth: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      authMode: "internal",
      plan: "pro",
    },
    channel: parseChannelRow(row),
  };
}

async function lookupActionableOutbound(channelId: string): Promise<{
  auth: AuthContext;
  channelKind: NotificationChannelKind;
  metadata: Record<string, unknown>;
} | null> {
  const result = await pool.query<ChannelMessageRow & { tenant_id: string; user_id: string }>(
    `SELECT id, tenant_id, user_id, channel_id, kind, direction, body, metadata_json, created_at
     FROM channel_messages
     WHERE channel_id = $1
       AND direction = 'outbound'
     ORDER BY created_at DESC
     LIMIT 10`,
    [channelId]
  );
  for (const row of result.rows) {
    const metadata = readObject(row.metadata_json);
    if (typeof metadata.approvalToken === "string") {
      const kind = asChannelKind(row.kind);
      if (!kind) continue;
      return {
        auth: {
          tenantId: row.tenant_id,
          userId: row.user_id,
          authMode: "internal",
          plan: "pro",
        },
        channelKind: kind,
        metadata,
      };
    }
    if (metadata.gateId && metadata.runId) {
      const kind = asChannelKind(row.kind);
      if (!kind) continue;
      return {
        auth: {
          tenantId: row.tenant_id,
          userId: row.user_id,
          authMode: "internal",
          plan: "pro",
        },
        channelKind: kind,
        metadata,
      };
    }
  }
  return null;
}

async function setTelegramWebhook(botToken: string): Promise<void> {
  const secret = config.channelsTelegramWebhookSecret.trim();
  const webhookBaseUrl = config.publicBaseUrl.replace(/\/$/, "");
  if (!webhookBaseUrl) return;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${webhookBaseUrl}/api/channels/webhooks/telegram`,
      ...(secret ? { secret_token: secret } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram setWebhook failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
}

async function verifyTelegramBotToken(botToken: string): Promise<{ username: string | null }> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string } };
  if (!response.ok || !payload.ok) {
    throw new Error("Telegram bot token validation failed");
  }
  return { username: typeof payload.result?.username === "string" ? payload.result.username : null };
}

async function sendTelegramMessage(input: {
  channel: NotificationChannelConfig;
  text: string;
  approvalMessageId?: string;
  approvalUrl?: string;
}): Promise<DeliveryResult> {
  const chatId = String(input.channel.config.chatId ?? input.channel.destination);
  const botTokenCiphertext = typeof input.channel.config.botTokenCiphertext === "string"
    ? input.channel.config.botTokenCiphertext
    : null;
  const botToken = botTokenCiphertext ? "" : config.channelsTelegramBotToken.trim();
  let resolvedToken = botToken;
  if (!resolvedToken && botTokenCiphertext) {
    try {
      const { decryptMemoryContent } = await import("../infrastructure/crypto/memory-crypto.js");
      resolvedToken = decryptMemoryContent(botTokenCiphertext);
    } catch {
      resolvedToken = "";
    }
  }
  if (!resolvedToken) {
    return { ok: false, provider: "telegram", error: "Telegram bot token is not configured" };
  }
  const inlineKeyboard = input.approvalMessageId
    ? {
        inline_keyboard: [[
          { text: "Approve", callback_data: `approve:${input.approvalMessageId}` },
          { text: "Skip", callback_data: `skip:${input.approvalMessageId}` },
        ]],
      }
    : undefined;
  const response = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: input.text,
      ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {}),
      ...(input.approvalUrl ? { disable_web_page_preview: true } : {}),
    }),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: { message_id?: number }; description?: string };
  if (!response.ok || !body.ok) {
    return {
      ok: false,
      provider: "telegram",
      error: typeof body.description === "string" ? body.description : `HTTP ${response.status}`,
    };
  }
  return {
    ok: true,
    provider: "telegram",
    externalMessageId: typeof body.result?.message_id === "number" ? String(body.result.message_id) : undefined,
  };
}

async function sendWhatsAppMessage(input: {
  channel: NotificationChannelConfig;
  text: string;
}): Promise<DeliveryResult> {
  const baseUrl = config.channelsWhatsAppOpenWaUrl.trim().replace(/\/$/, "");
  if (baseUrl) {
    const response = await fetch(`${baseUrl}/sendText`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.channelsWhatsAppOpenWaToken ? { authorization: `Bearer ${config.channelsWhatsAppOpenWaToken}` } : {}),
      },
      body: JSON.stringify({
        chatId: input.channel.destination,
        text: input.text,
      }),
    });
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, provider: "open-wa", error: `HTTP ${response.status}${body ? `: ${body}` : ""}` };
    }
    return { ok: true, provider: "open-wa" };
  }

  const legacyWebhookUrl = config.notificationsWhatsAppWebhookUrl.trim();
  if (!legacyWebhookUrl || config.notificationsWhatsAppAdapter !== "webhook") {
    return { ok: false, provider: "whatsapp", error: "WhatsApp delivery is not configured" };
  }
  const response = await fetch(legacyWebhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.notificationsWhatsAppWebhookToken
        ? { authorization: `Bearer ${config.notificationsWhatsAppWebhookToken}` }
        : {}),
    },
    body: JSON.stringify({
      to: input.channel.destination,
      text: input.text,
    }),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, provider: "whatsapp", error: `HTTP ${response.status}${body ? `: ${body}` : ""}` };
  }
  return { ok: true, provider: "whatsapp" };
}

async function sendEmailMessage(input: {
  auth: AuthContext;
  channel: NotificationChannelConfig;
  subject: string;
  text: string;
  replyAddress?: string | null;
}): Promise<DeliveryResult> {
  const result = await sendResendEmail({
    auth: input.auth,
    to: input.channel.destination,
    subject: input.subject,
    text: input.text,
    html: `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;">${input.text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    replyTo: input.replyAddress ?? undefined,
  });
  if (!result.ok) {
    return {
      ok: false,
      provider: "resend",
      error: result.error ?? `HTTP ${result.status ?? 0}`,
    };
  }
  return {
    ok: true,
    provider: "resend",
    externalMessageId: result.id,
  };
}

async function deliverToChannel(input: {
  auth: AuthContext;
  channel: NotificationChannelConfig;
  subject: string;
  text: string;
  metadata?: Record<string, unknown>;
  approvalMessageId?: string;
  approvalUrl?: string;
  replyAddress?: string | null;
}): Promise<DeliveryResult> {
  if (input.channel.kind === "telegram") {
    return sendTelegramMessage({
      channel: input.channel,
      text: input.text,
      approvalMessageId: input.approvalMessageId,
      approvalUrl: input.approvalUrl,
    });
  }
  if (input.channel.kind === "whatsapp") {
    return sendWhatsAppMessage({ channel: input.channel, text: input.text });
  }
  return sendEmailMessage({
    auth: input.auth,
    channel: input.channel,
    subject: input.subject,
    text: input.text,
    replyAddress: input.replyAddress,
  });
}

export async function listChannelsOverview(auth: AuthContext): Promise<ChannelsOverview> {
  await ensureDefaultGmailChannel(auth);
  const [channelsResult, messagesResult] = await Promise.all([
    pool.query<ChannelRow>(
      `SELECT id, kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
       FROM notification_channels
       WHERE tenant_id = $1
         AND user_id = $2
       ORDER BY is_primary DESC, created_at ASC`,
      [auth.tenantId, auth.userId]
    ),
    pool.query<ChannelMessageRow>(
      `SELECT m.id, m.channel_id, m.kind, m.direction, m.body, m.metadata_json, m.created_at
       FROM channel_messages m
       WHERE m.tenant_id = $1
         AND m.user_id = $2
       ORDER BY m.created_at DESC
       LIMIT 20`,
      [auth.tenantId, auth.userId]
    ),
  ]);
  const messages: ChannelMessageView[] = [];
  for (const row of messagesResult.rows) {
    const kind = asChannelKind(row.kind);
    if (!kind || !isManagedChannelKind(kind)) continue;
    messages.push({
      id: row.id,
      channelId: row.channel_id,
      kind,
      direction: row.direction,
      body: row.body,
      metadata: readObject(row.metadata_json),
      createdAt: row.created_at,
    });
  }
  return {
    channels: channelsResult.rows
      .map(parseChannelRow)
      .filter((channel) => isManagedChannelKind(channel.kind)),
    messages,
  };
}

export async function listEnabledNotificationChannels(auth: AuthContext): Promise<NotificationChannelConfig[]> {
  await ensureDefaultGmailChannel(auth);
  const result = await pool.query<ChannelRow>(
    `SELECT kind, destination, id, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
     FROM notification_channels
     WHERE tenant_id = $1
       AND user_id = $2
       AND enabled = TRUE
     ORDER BY is_primary DESC, verified_at DESC NULLS LAST, created_at ASC`,
    [auth.tenantId, auth.userId]
  );
  const channels = result.rows
    .map(parseChannelRow)
    .filter(isEnabledChannel)
    .filter((channel) => isManagedChannelKind(channel.kind));
  const primary = channels.find((channel) => channel.isPrimary);
  const visible = primary ? [primary] : channels;
  return visible.map((channel) => ({
    id: channel.id,
    kind: channel.kind,
    destination: channel.destination,
    isPrimary: channel.isPrimary,
    label: channel.label,
    config: channel.config,
  }));
}

export async function getPrimaryNotificationChannel(auth: AuthContext): Promise<NotificationChannelConfig | null> {
  const channels = await listEnabledNotificationChannels(auth);
  return channels[0] ?? null;
}

export async function resolvePrimaryEmailDestination(auth: AuthContext): Promise<string | null> {
  const primary = await getPrimaryNotificationChannel(auth);
  if (primary && (primary.kind === "email" || primary.kind === "gmail")) {
    return primary.destination;
  }
  const result = await pool.query<{ destination: string }>(
    `SELECT destination
     FROM notification_channels
     WHERE tenant_id = $1
       AND user_id = $2
       AND enabled = TRUE
       AND kind IN ('email', 'gmail')
     ORDER BY is_primary DESC, created_at ASC
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );
  const destination = result.rows[0]?.destination?.trim();
  return destination ? destination : null;
}

export async function startChannelSetup(input: {
  auth: AuthContext;
  kind: NotificationChannelKind;
  mode?: ChannelSetupMode;
  label?: string | null;
  botToken?: string | null;
}): Promise<ChannelSetupSessionView> {
  if (!isManagedChannelKind(input.kind)) {
    throw new Error(`${input.kind} channel setup is not supported`);
  }
  const mode = input.mode ?? "default";
  if (input.kind === "gmail" || input.kind === "email") {
    const user = await getUserById(input.auth.userId);
    if (!user?.email) {
      throw new Error("Signed-in email is not available for inbox setup");
    }
    await upsertNotificationChannel({
      auth: input.auth,
      kind: input.kind === "email" ? "email" : "gmail",
      destination: user.email,
      label: input.label ?? "Primary inbox",
      verified: true,
      status: "connected",
      config: { provider: "resend" },
    });
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return {
      id: randomUUID(),
      kind: input.kind,
      mode,
      status: "connected",
      expiresAt,
      nonce: null,
      pairingCode: null,
      deepLinkUrl: null,
      metadata: { connectedEmail: user.email },
    };
  }

  const setupId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const nonce = makeSetupNonce(input.kind);
  const pairingCode = null;
  const metadata: Record<string, unknown> = {
    label: input.label ?? null,
    deepLinkUrl: buildTelegramDeepLink(nonce, config.channelsTelegramBotUsername),
  };
  if (mode === "botfather" && input.botToken?.trim()) {
    metadata.botTokenCiphertext = encryptMemoryContent(input.botToken.trim());
  }
  await pool.query(
    `INSERT INTO channel_setup_sessions
     (id, tenant_id, user_id, kind, mode, status, nonce, pairing_code, metadata_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9::timestamptz)`,
    [
      setupId,
      input.auth.tenantId,
      input.auth.userId,
      input.kind,
      mode,
      nonce,
      pairingCode,
      JSON.stringify(metadata),
      expiresAt,
    ]
  );
  return {
    id: setupId,
    kind: input.kind,
    mode,
    status: "pending",
    expiresAt,
    nonce,
    pairingCode,
    deepLinkUrl: typeof metadata.deepLinkUrl === "string" ? metadata.deepLinkUrl : null,
    metadata,
  };
}

export async function completeChannelSetup(input: {
  auth: AuthContext;
  sessionId: string;
  botToken?: string | null;
}): Promise<ChannelSetupSessionView> {
  const result = await pool.query<ChannelSetupRow>(
    `SELECT id, kind, mode, status, nonce, pairing_code, expires_at, metadata_json
     FROM channel_setup_sessions
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.sessionId, input.auth.tenantId, input.auth.userId]
  );
  const session = result.rows[0];
  if (!session) {
    throw new Error("Channel setup session not found");
  }
  const metadata = readObject(session.metadata_json);
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await pool.query(
      `UPDATE channel_setup_sessions
       SET status = 'expired',
           updated_at = NOW()
       WHERE id = $1`,
      [input.sessionId]
    );
    throw new Error("Channel setup session expired");
  }
  if (session.kind === "telegram" && session.mode === "botfather") {
    const rawToken = input.botToken?.trim()
      || (typeof metadata.botTokenCiphertext === "string" ? "" : "");
    let botToken = rawToken;
    if (!botToken && typeof metadata.botTokenCiphertext === "string") {
      const { decryptMemoryContent } = await import("../infrastructure/crypto/memory-crypto.js");
      botToken = decryptMemoryContent(metadata.botTokenCiphertext);
    }
    if (!botToken) {
      throw new Error("Telegram BotFather token is required");
    }
    const me = await verifyTelegramBotToken(botToken);
    await setTelegramWebhook(botToken);
    await pool.query(
      `UPDATE channel_setup_sessions
       SET metadata_json = metadata_json || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        input.sessionId,
        JSON.stringify({
          botUsername: me.username,
          botTokenCiphertext: encryptMemoryContent(botToken),
          deepLinkUrl: me.username ? buildTelegramDeepLink(session.nonce ?? makeSetupNonce("telegram"), me.username) : null,
        }),
      ]
    );
  }
  const refreshed = await pool.query<ChannelSetupRow>(
    `SELECT id, kind, mode, status, nonce, pairing_code, expires_at, metadata_json
     FROM channel_setup_sessions
     WHERE id = $1`,
    [input.sessionId]
  );
  return parseSetupRow(refreshed.rows[0]);
}

export async function setPrimaryChannel(auth: AuthContext, channelId: string): Promise<NotificationChannelView> {
  const channel = await lookupChannelById(auth, channelId);
  await pool.query(
    `UPDATE notification_channels
     SET is_primary = FALSE,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2`,
    [auth.tenantId, auth.userId]
  );
  await pool.query(
    `UPDATE notification_channels
     SET is_primary = TRUE,
         enabled = TRUE,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [channelId, auth.tenantId, auth.userId]
  );
  return lookupChannelById(auth, channelId);
}

export async function disconnectChannel(auth: AuthContext, channelId: string): Promise<void> {
  await lookupChannelById(auth, channelId);
  await pool.query(
    `UPDATE notification_channels
     SET enabled = FALSE,
         is_primary = FALSE,
         status = 'revoked',
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [channelId, auth.tenantId, auth.userId]
  );
}

export async function sendChannelTest(auth: AuthContext, channelId: string): Promise<DeliveryResult> {
  const channelView = await lookupChannelById(auth, channelId);
  const channel: NotificationChannelConfig = {
    id: channelView.id,
    kind: channelView.kind,
    destination: channelView.destination,
    isPrimary: channelView.isPrimary,
    label: channelView.label,
    config: channelView.config,
  };
  const channelLabel = channel.kind === "gmail" || channel.kind === "email" ? "inbox" : "telegram";
  const text = channelMessageText({
    title: "Tallei channel check",
    reason: `This confirms that ${channelLabel} is ready to receive loop updates.`,
    footer: channel.kind === "gmail" || channel.kind === "email"
      ? "Reply to this email and Tallei will store the message in the shared channel inbox."
      : "Reply here and Tallei will store the message in the shared channel inbox.",
  });
  await recordNotificationDeliveryAttempt({
    auth,
    channel: channel.kind,
    targetType: "channel_test",
    targetId: channel.id,
    status: "queued",
    payload: { destination: channel.destination },
  });
  const replyAddress = buildReplyAddress(channel.id);
  const delivery = await deliverToChannel({
    auth,
    channel,
    subject: "Tallei channel check",
    text,
    replyAddress,
  });
  await recordNotificationDeliveryAttempt({
    auth,
    channel: channel.kind,
    targetType: "channel_test",
    targetId: channel.id,
    status: delivery.ok ? "sent" : "failed",
    payload: { destination: channel.destination, provider: delivery.provider, error: delivery.error ?? null },
  });
  if (delivery.ok) {
    await recordChannelMessage({
      auth,
      channelId: channel.id,
      channelKind: channel.kind,
      direction: "outbound",
      body: text,
      metadata: { subject: "Tallei channel check" },
    });
  }
  return delivery;
}

export async function deliverApprovalPrompt(input: ApprovalPromptInput): Promise<DeliveryResult> {
  const text = channelMessageText({
    title: input.title,
    reason: input.reason,
    approvalUrl: input.approvalUrl,
    draftOutput: input.draftOutput,
    suggestedPrompt: input.suggestedPrompt,
    footer: "Reply APPROVE to approve or SKIP to skip.",
  });
  const replyAddress = buildReplyAddress(input.channel.id);
  await recordNotificationDeliveryAttempt({
    auth: input.auth,
    channel: input.channel.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    status: "queued",
    payload: {
      destination: input.channel.destination,
      approvalUrl: input.approvalUrl,
    },
  });
  const messageId = await recordChannelMessage({
    auth: input.auth,
    channelId: input.channel.id,
    channelKind: input.channel.kind,
    direction: "outbound",
    body: text,
    metadata: {
      approvalToken: input.approvalToken,
      approvalUrl: input.approvalUrl,
      targetType: input.targetType,
      targetId: input.targetId,
    },
  });
  const delivery = await deliverToChannel({
    auth: input.auth,
    channel: input.channel,
    subject: input.title,
    text,
    approvalMessageId: input.channel.kind === "telegram" ? messageId : undefined,
    approvalUrl: input.approvalUrl,
    replyAddress,
  });
  await recordNotificationDeliveryAttempt({
    auth: input.auth,
    channel: input.channel.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    status: delivery.ok ? "sent" : "failed",
    payload: {
      destination: input.channel.destination,
      approvalUrl: input.approvalUrl,
      provider: delivery.provider,
      externalMessageId: delivery.externalMessageId ?? null,
      error: delivery.error ?? null,
    },
  });
  return delivery;
}

export async function deliverStatusNotification(input: StatusNotificationInput): Promise<DeliveryResult | null> {
  const channel = input.channel ?? await getPrimaryNotificationChannel(input.auth);
  if (!channel) {
    return null;
  }
  const text = `${input.title}\n\n${input.body}`;
  await recordNotificationDeliveryAttempt({
    auth: input.auth,
    channel: channel.kind,
    targetType: "loop_status",
    targetId: channel.id,
    status: "queued",
    payload: input.metadata ?? {},
  });
  const delivery = await deliverToChannel({
    auth: input.auth,
    channel,
    subject: input.title,
    text,
    replyAddress: buildReplyAddress(channel.id),
  });
  await recordNotificationDeliveryAttempt({
    auth: input.auth,
    channel: channel.kind,
    targetType: "loop_status",
    targetId: channel.id,
    status: delivery.ok ? "sent" : "failed",
    payload: {
      ...input.metadata,
      provider: delivery.provider,
      externalMessageId: delivery.externalMessageId ?? null,
      error: delivery.error ?? null,
    },
  });
  if (delivery.ok) {
    await recordChannelMessage({
      auth: input.auth,
      channelId: channel.id,
      channelKind: channel.kind,
      direction: "outbound",
      body: text,
      metadata: input.metadata,
    });
  }
  return delivery;
}

export async function sendWorkflowRunApprovalPrompt(input: WorkflowRunApprovalPromptInput): Promise<WorkflowRunApprovalPromptResult> {
  const primaryChannel = await getPrimaryNotificationChannel(input.auth);
  const to = await resolvePrimaryEmailDestination(input.auth);
  const runUrl = `${config.frontendUrl.replace(/\/$/, "")}/dashboard/loops/${input.workflowId}/runs/${input.runId}`;
  const artifactKind = input.artifactKind?.trim() || "draft";
  const subject = `Approval required: ${input.workflowTitle}`;
  const preview = input.artifactBody.trim().slice(0, 4000);
  const reason = `Your ${artifactKind} is ready for review.`;

  if (primaryChannel && primaryChannel.kind === "telegram") {
    const result = await deliverApprovalPrompt({
      auth: input.auth,
      channel: primaryChannel,
      targetType: "workflow_run",
      targetId: input.runId,
      approvalUrl: input.approvalUrl,
      approvalToken: input.approvalToken,
      title: subject,
      reason,
      suggestedPrompt: `Open the run in Tallei: ${runUrl}`,
      draftOutput: preview,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "Failed to deliver approval prompt");
    }
    return {
      to: primaryChannel.destination,
      sentAt: new Date().toISOString(),
      channel: primaryChannel.kind,
    };
  }

  if (!to) {
    throw new Error("No enabled email notification channel found. Add an email destination in notification settings.");
  }

  const text = [
    reason,
    "",
    preview,
    "",
    `Approve this draft: ${input.approvalUrl}`,
    "",
    `Or open the run in Tallei: ${runUrl}`,
  ].join("\n");
  const html = [
    `<p>${escapeHtml(reason)}</p>`,
    `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.5;">${escapeHtml(preview)}</pre>`,
    `<p><a href="${input.approvalUrl}">Approve this draft</a></p>`,
    `<p><a href="${runUrl}">Open run in Tallei</a></p>`,
  ].join("");
  const result = await sendResendEmail({ to, subject, text, html, auth: input.auth });
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to send approval email");
  }
  return {
    to,
    sentAt: new Date().toISOString(),
    channel: primaryChannel?.kind ?? "email",
  };
}

function parseApprovalCommand(body: string): "approve" | "skip" | "none" {
  const normalized = body.trim().toLowerCase();
  if (/^(approve|approved|yes|ship)\b/.test(normalized)) return "approve";
  if (/^(skip|dismiss|no)\b/.test(normalized)) return "skip";
  return "none";
}

async function bindChannelFromSetup(input: {
  kind: NotificationChannelKind;
  destination: string;
  nonce?: string | null;
  pairingCode?: string | null;
  config?: Record<string, unknown>;
}): Promise<{ auth: AuthContext; channel: NotificationChannelView } | null> {
  let whereField = input.nonce ? "nonce" : input.pairingCode ? "pairing_code" : null;
  let whereValue = input.nonce ?? input.pairingCode ?? null;
  if (!whereField || !whereValue) return null;
  const result = await pool.query<ChannelSetupRow & { tenant_id: string; user_id: string }>(
    `SELECT id, tenant_id, user_id, kind, mode, status, nonce, pairing_code, expires_at, metadata_json
     FROM channel_setup_sessions
     WHERE ${whereField} = $1
       AND kind = $2
       AND status = 'pending'
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [whereValue, input.kind]
  );
  const session = result.rows[0];
  if (!session) return null;
  const auth: AuthContext = {
    tenantId: session.tenant_id,
    userId: session.user_id,
    authMode: "internal",
    plan: "pro",
  };
  const metadata = readObject(session.metadata_json);
  const channel = await upsertNotificationChannel({
    auth,
    kind: input.kind,
    destination: input.destination,
    label: typeof metadata.label === "string" ? metadata.label : null,
    verified: true,
    status: "connected",
    config: {
      ...input.config,
      ...(typeof metadata.botTokenCiphertext === "string" ? { botTokenCiphertext: metadata.botTokenCiphertext } : {}),
      ...(typeof metadata.botUsername === "string" ? { botUsername: metadata.botUsername } : {}),
    },
  });
  await pool.query(
    `UPDATE channel_setup_sessions
     SET status = 'connected',
         completed_at = NOW(),
         metadata_json = metadata_json || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [session.id, JSON.stringify({ channelId: channel.id, destination: input.destination })]
  );
  return { auth, channel };
}

export async function processTelegramWebhook(input: {
  body: unknown;
  secretToken?: string;
}): Promise<InboundChannelAction> {
  if (config.channelsTelegramWebhookSecret && input.secretToken !== config.channelsTelegramWebhookSecret) {
    throw new Error("Invalid Telegram webhook secret");
  }
  const payload = readObject(input.body);
  const message = readObject(payload.message);
  const callback = readObject(payload.callback_query);

  if (typeof callback.data === "string") {
    const [decision, messageId] = callback.data.split(":");
    if ((decision === "approve" || decision === "skip") && messageId) {
      const result = await pool.query<ChannelMessageRow & { tenant_id: string; user_id: string }>(
        `SELECT id, tenant_id, user_id, channel_id, kind, direction, body, metadata_json, created_at
         FROM channel_messages
         WHERE id = $1
         LIMIT 1`,
        [messageId]
      );
      const row = result.rows[0];
      if (!row) return { type: "none" };
      const metadata = readObject(row.metadata_json);
      return {
        type: decision,
        tenantId: row.tenant_id,
        userId: row.user_id,
        channel: asChannelKind(row.kind) ?? undefined,
        token: typeof metadata.approvalToken === "string" ? metadata.approvalToken : undefined,
      };
    }
  }

  const chat = readObject(message.chat);
  const chatId = typeof chat.id === "number" || typeof chat.id === "string" ? String(chat.id) : null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!chatId) return { type: "none" };

  const startMatch = text.match(/^\/start\s+([A-Za-z0-9_:-]+)$/);
  if (startMatch?.[1]) {
    const bound = await bindChannelFromSetup({
      kind: "telegram",
      destination: chatId,
      nonce: startMatch[1],
      config: {
        chatId,
        username: typeof chat.username === "string" ? chat.username : null,
        firstName: typeof readObject(message.from).first_name === "string" ? readObject(message.from).first_name : null,
      },
    });
    if (bound) {
      await recordChannelMessage({
        auth: bound.auth,
        channelId: bound.channel.id,
        channelKind: "telegram",
        direction: "inbound",
        body: text,
        metadata: { setupBound: true },
      });
    }
    return { type: "none" };
  }

  const mapped = await lookupChannelByDestination("telegram", chatId);
  if (!mapped) return { type: "none" };
  await recordChannelMessage({
    auth: mapped.auth,
    channelId: mapped.channel.id,
    channelKind: "telegram",
    direction: "inbound",
    body: text,
  });
  const actionable = await lookupActionableOutbound(mapped.channel.id);
  const command = parseApprovalCommand(text);
  if (command !== "none" && actionable?.metadata.approvalToken && typeof actionable.metadata.approvalToken === "string") {
    return {
      type: command,
      tenantId: mapped.auth.tenantId,
      userId: mapped.auth.userId,
      channel: "telegram",
      token: actionable.metadata.approvalToken,
    };
  }
  if (typeof actionable?.metadata.gateId === "string" && typeof actionable.metadata.runId === "string" && text.length > 0) {
    return {
      type: "gate_input",
      tenantId: mapped.auth.tenantId,
      userId: mapped.auth.userId,
      channel: "telegram",
      runId: actionable.metadata.runId,
      gateId: actionable.metadata.gateId,
      value: text,
    };
  }
  return {
    type: "message",
    tenantId: mapped.auth.tenantId,
    userId: mapped.auth.userId,
    channel: "telegram",
    body: text,
  };
}

function pickWhatsAppText(body: Record<string, unknown>): { sender: string | null; text: string } {
  const data = readObject(body.data);
  const message = readObject(data.message);
  const sender = typeof body.from === "string"
    ? body.from
    : typeof data.from === "string"
      ? data.from
      : typeof message.from === "string"
        ? message.from
        : null;
  const text = typeof body.body === "string"
    ? body.body
    : typeof message.body === "string"
      ? message.body
      : typeof readObject(message.text).body === "string"
        ? String(readObject(message.text).body)
        : "";
  return { sender, text: text.trim() };
}

export async function processWhatsAppWebhook(input: {
  body: unknown;
  authorization?: string;
}): Promise<InboundChannelAction> {
  if (config.channelsWhatsAppWebhookToken) {
    const expected = `Bearer ${config.channelsWhatsAppWebhookToken}`;
    if (input.authorization !== expected) {
      throw new Error("Invalid WhatsApp webhook token");
    }
  }
  const payload = readObject(input.body);
  const { sender, text } = pickWhatsAppText(payload);
  if (!sender) return { type: "none" };
  const pairMatch = text.match(/^(?:pair\s+)?([A-F0-9]{8})$/i);
  if (pairMatch?.[1]) {
    const bound = await bindChannelFromSetup({
      kind: "whatsapp",
      destination: sender,
      pairingCode: pairMatch[1].toUpperCase(),
      config: { chatId: sender },
    });
    if (bound) {
      await recordChannelMessage({
        auth: bound.auth,
        channelId: bound.channel.id,
        channelKind: "whatsapp",
        direction: "inbound",
        body: text,
        metadata: { setupBound: true },
      });
    }
    return { type: "none" };
  }
  const mapped = await lookupChannelByDestination("whatsapp", sender);
  if (!mapped) return { type: "none" };
  await recordChannelMessage({
    auth: mapped.auth,
    channelId: mapped.channel.id,
    channelKind: "whatsapp",
    direction: "inbound",
    body: text,
  });
  const actionable = await lookupActionableOutbound(mapped.channel.id);
  const command = parseApprovalCommand(text);
  if (command !== "none" && typeof actionable?.metadata.approvalToken === "string") {
    return {
      type: command,
      tenantId: mapped.auth.tenantId,
      userId: mapped.auth.userId,
      channel: "whatsapp",
      token: actionable.metadata.approvalToken,
    };
  }
  if (typeof actionable?.metadata.gateId === "string" && typeof actionable.metadata.runId === "string" && text.length > 0) {
    return {
      type: "gate_input",
      tenantId: mapped.auth.tenantId,
      userId: mapped.auth.userId,
      channel: "whatsapp",
      runId: actionable.metadata.runId,
      gateId: actionable.metadata.gateId,
      value: text,
    };
  }
  return {
    type: "message",
    tenantId: mapped.auth.tenantId,
    userId: mapped.auth.userId,
    channel: "whatsapp",
    body: text,
  };
}

async function fetchReceivedResendEmail(emailId: string): Promise<{ text: string | null }> {
  if (!config.signupResendApiKey) {
    return { text: null };
  }
  const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: {
      authorization: `Bearer ${config.signupResendApiKey}`,
      "content-type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({})) as { text?: string | null; data?: { text?: string | null } };
  if (!response.ok) {
    return { text: null };
  }
  return { text: typeof body.text === "string" ? body.text : typeof body.data?.text === "string" ? body.data.text : null };
}

function extractChannelIdFromReplyAddress(addresses: string[]): string | null {
  for (const address of addresses) {
    const match = address.match(/reply\+([0-9a-f-]{36})@/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export async function processResendInboundWebhook(input: { body: unknown }): Promise<InboundChannelAction> {
  const payload = readObject(input.body);
  if (payload.type !== "email.received") {
    return { type: "none" };
  }
  const data = readObject(payload.data);
  const recipients = Array.isArray(data.to)
    ? data.to.filter((value): value is string => typeof value === "string")
    : [];
  const channelId = extractChannelIdFromReplyAddress(recipients);
  if (!channelId) return { type: "none" };
  const result = await pool.query<ChannelRow & { tenant_id: string; user_id: string }>(
    `SELECT id, tenant_id, user_id, kind, destination, enabled, is_primary, status, label, verified_at, last_error, last_error_at, config_json, created_at, updated_at
     FROM notification_channels
     WHERE id = $1
     LIMIT 1`,
    [channelId]
  );
  const row = result.rows[0];
  if (!row) return { type: "none" };
  const auth: AuthContext = {
    tenantId: row.tenant_id,
    userId: row.user_id,
    authMode: "internal",
    plan: "pro",
  };
  const emailId = typeof data.email_id === "string" ? data.email_id : null;
  const fetched = emailId ? await fetchReceivedResendEmail(emailId) : { text: null };
  const text = (fetched.text ?? (typeof data.subject === "string" ? data.subject : "")).trim();
  const kind = asChannelKind(row.kind);
  if (!kind) return { type: "none" };
  await recordChannelMessage({
    auth,
    channelId,
    channelKind: kind,
    direction: "inbound",
    body: text,
    metadata: {
      subject: typeof data.subject === "string" ? data.subject : null,
      messageId: typeof data.message_id === "string" ? data.message_id : null,
      from: data.from ?? null,
      to: recipients,
    },
  });
  const actionable = await lookupActionableOutbound(channelId);
  const command = parseApprovalCommand(text);
  if (command !== "none" && typeof actionable?.metadata.approvalToken === "string") {
    return {
      type: command,
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel: kind,
      token: actionable.metadata.approvalToken,
    };
  }
  if (typeof actionable?.metadata.gateId === "string" && typeof actionable.metadata.runId === "string" && text.length > 0) {
    return {
      type: "gate_input",
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel: kind,
      runId: actionable.metadata.runId,
      gateId: actionable.metadata.gateId,
      value: text,
    };
  }
  return {
    type: "message",
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel: kind,
    body: text,
  };
}

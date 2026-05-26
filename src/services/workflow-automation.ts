import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { generateText, stepCountIs } from "ai";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import {
  dailyIntelligenceWorkflowInputSchema,
  workflowRunWorkflowInputSchema,
  WORKFLOW_DEFINITIONS,
} from "../orchestration/workflows/definitions.js";
import { sendResendEmail } from "./resend-email.js";
import { isWorkflowSdkEnabled } from "./workflow-sdk-runtime.js";
import {
  cancelWorkflowSdkRun,
  completeWorkflowSdkRun,
  createWorkflowSdkRun,
  getWorkflowSdkRunDetails,
  type WorkflowSdkRunStatus,
} from "./workflow-sdk-runtime.js";
import { encryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { runMemoryCleanupForUser, sendMemoryCleanupAdminEmail } from "./memory-cleanup.js";
import { runDailyIntelligencePipeline } from "./workflow-automation/daily-intelligence.js";

export type ConnectorSetupState =
  | "not_required"
  | "missing"
  | "auth_started"
  | "connected"
  | "expired"
  | "revoked"
  | "failed";

export type WorkflowSuggestionStatus = "pending" | "approved" | "dismissed";

export interface WorkflowSuggestion {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  status: WorkflowSuggestionStatus;
  confidence: number;
  fingerprint: string;
  triggerCount: number;
  createdAt: string;
}

export interface ConnectorAccountView {
  id: string;
  provider: string;
  appKey: string | null;
  externalAccountId: string;
  status: ConnectorSetupState;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResendConnectorSetupView {
  provider: "resend";
  status: "connected" | "missing";
  portalUrl: string;
  apiKeysUrl: string;
  docsUrl: string;
  steps: string[];
  connection?: {
    id: string;
    status: ConnectorSetupState;
    createdAt: string;
    updatedAt: string;
    last4: string | null;
    label: string | null;
  };
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  status: string;
  runMode: string;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  draftOutput: string | null;
  connectorActionStatus: string | null;
  sdkRunId?: string | null;
  sdkRun?: {
    run: unknown;
    events: unknown[];
  } | null;
}

export interface WorkflowView {
  id: string;
  title: string;
  fingerprint: string;
  scheduleRrule: string;
  status: string;
  requiresConnector: boolean;
  connectorProvider: string | null;
  connectorScopeKeys: string[];
  definitionVersion?: string;
  definition_version?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunStepView {
  id: string;
  stepName: string;
  status: string;
  idempotencyKey: string;
  input: unknown;
  output: unknown;
  error: unknown;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

type NotificationChannel = "email" | "whatsapp";
type ApprovalTargetType = "workflow_suggestion" | "workflow_run";

interface ConnectorAdapter {
  provider: "composio" | "native" | "mock";
  startAuthSession(input: {
    auth: AuthContext;
    providerKey: string;
    appKey?: string | null;
    redirectUri?: string | null;
    requiredScopes: string[];
  }): Promise<{ sessionId: string; setupUrl: string; expiresAt: string }>;
  getConnectionStatus(input: {
    auth: AuthContext;
    providerKey: string;
  }): Promise<ConnectorSetupState>;
  listAvailableTools(input: {
    auth: AuthContext;
    providerKey: string;
  }): Promise<Array<{ name: string; description: string }>>;
  executeAction(input: {
    auth: AuthContext;
    providerKey: string;
    accountId: string;
    actionName: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; output: Record<string, unknown> }>;
}

interface NotificationDeliveryResult {
  ok: boolean;
  provider: string;
  externalMessageId?: string;
  error?: string;
}

interface NotificationAdapter {
  kind: NotificationChannel;
  sendApprovalPrompt(input: {
    auth: AuthContext;
    targetType: ApprovalTargetType;
    targetId: string;
    approvalUrl: string;
    title: string;
    reason: string;
    suggestedPrompt: string;
    draftOutput?: string | null;
    to: string;
  }): Promise<NotificationDeliveryResult>;
}

interface NotificationChannelConfig {
  kind: NotificationChannel;
  destination: string;
}

function getComposioEntityId(auth: AuthContext): string {
  return `${config.composioEntityPrefix}:${auth.tenantId}:${auth.userId}`;
}

function inferComposioAppKey(scopes: string[]): string {
  const first = scopes.find((scope) => scope.trim().length > 0)?.trim().toLowerCase();
  if (!first) return "gmail";

  // Handle full Google OAuth scope URLs like https://www.googleapis.com/auth/gmail.send
  if (first.startsWith("https://www.googleapis.com/auth/")) {
    const service = first.replace("https://www.googleapis.com/auth/", "").split(".")[0];
    if (service === "gmail" || service === "mail") return "gmail";
    if (service === "calendar") return "googlecalendar";
    if (service === "drive" || service === "docs" || service === "sheets" || service === "slides") return "google";
    return service || "gmail";
  }

  // Handle Google workspace scopes like https://mail.google.com/
  if (first.includes("google.com") || first.includes("googleapis.com")) {
    if (first.includes("mail")) return "gmail";
    if (first.includes("calendar")) return "googlecalendar";
    if (first.includes("drive")) return "google";
    return "google";
  }

  // For simple scope names like "gmail", "slack", "github"
  return first.split(/[.:/]/)[0] || "gmail";
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function resolveConnectorAppKey(input: {
  provider: string;
  scopes: string[];
  metadata: unknown;
}): string | null {
  const metadata = toObjectRecord(input.metadata);
  const metadataAppKey = typeof metadata.appKey === "string"
    ? metadata.appKey.trim().toLowerCase()
    : "";
  if (metadataAppKey.length > 0) return metadataAppKey;
  if (input.scopes.length > 0) return inferComposioAppKey(input.scopes);
  const providerKey = input.provider.trim().toLowerCase();
  if (providerKey.length > 0 && providerKey !== "composio") return providerKey;
  return null;
}

function isComposioConfigured(): boolean {
  return Boolean(config.composioApiKey && config.composioBaseUrl);
}

function normalizeComposioAppKey(appKey: string | null | undefined): string {
  const key = (appKey ?? "").trim().toLowerCase();
  if (!key) return "gmail";
  if (key === "google_calendar") return "googlecalendar";
  if (key === "google-mail" || key === "googlemail") return "gmail";
  if (key === "resend_email") return "resend";
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMPOSIO_NATIVE_MODEL = process.env.TALLEI_CONNECTORS__COMPOSIO_NATIVE_MODEL || "claude-3-5-sonnet-latest";
let composioVercelClient: Composio<VercelProvider> | null = null;

function getComposioVercelClient(): Composio<VercelProvider> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }
  if (!composioVercelClient) {
    composioVercelClient = new Composio({
      apiKey: config.composioApiKey,
      provider: new VercelProvider(),
    });
  }
  return composioVercelClient;
}

async function createComposioConnectLink(input: {
  auth: AuthContext;
  authConfigId: string;
  redirectUri: string | null;
}): Promise<{ id: string | null; redirectUrl: string | null }> {
  const composio = getComposioVercelClient();
  const callbackUrl = input.redirectUri ?? null;
  const request = await composio.connectedAccounts.link(
    getComposioEntityId(input.auth),
    input.authConfigId,
    { allowMultiple: true, ...(callbackUrl ? { callbackUrl } : {}) }
  );
  const redirectUrl = typeof request.redirectUrl === "string" && request.redirectUrl.length > 0
    ? request.redirectUrl
    : null;
  const id = typeof request.id === "string" && request.id.length > 0 ? request.id : null;
  return { id, redirectUrl };
}

async function createComposioToolkitAuthorizeLink(input: {
  auth: AuthContext;
  toolkitSlug: string;
  redirectUri?: string | null;
}): Promise<{ id: string | null; redirectUrl: string | null }> {
  const composio = getComposioVercelClient();
  const entityId = getComposioEntityId(input.auth);

  // Find an existing ENABLED auth config for the toolkit
  const authConfigs = await composio.authConfigs.list({ toolkit: input.toolkitSlug });
  let authConfigId = authConfigs.items.find((ac) => ac.status === "ENABLED")?.id;

  // If no enabled auth config exists, try to create a Composio-managed one
  if (!authConfigId) {
    try {
      const toolkit = await composio.toolkits.get(input.toolkitSlug);
      const created = await composio.authConfigs.create(input.toolkitSlug, {
        type: "use_composio_managed_auth",
        name: `${toolkit.name} Auth Config`,
      });
      authConfigId = created.id;
      console.info(`[workflow] Created managed auth config for ${input.toolkitSlug}: ${authConfigId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[workflow] Failed to create managed auth config for ${input.toolkitSlug}: ${msg}`);
      throw new Error(`No enabled auth config found for toolkit "${input.toolkitSlug}" and failed to create one. Please set up an auth config in the Composio dashboard. ${msg}`);
    }
  }

  const linkOptions: { callbackUrl?: string; allowMultiple?: boolean } = { allowMultiple: true };
  if (input.redirectUri) {
    linkOptions.callbackUrl = input.redirectUri;
  }

  const request = await composio.connectedAccounts.link(entityId, authConfigId, linkOptions);
  const redirectUrl = typeof request.redirectUrl === "string" && request.redirectUrl.length > 0
    ? request.redirectUrl
    : null;
  const id = typeof request.id === "string" && request.id.length > 0 ? request.id : null;
  return { id, redirectUrl };
}

async function tryRunComposioNativeTool(input: {
  auth: AuthContext;
  actionName: string;
  payload: Record<string, unknown>;
  accountId: string;
}): Promise<Record<string, unknown> | null> {
  if (!config.anthropicApiKey) return null;
  if (!/^[A-Z0-9_]+$/.test(input.actionName)) return null;
  if (!isComposioConfigured()) return null;

  // @ai-sdk/anthropic reads from ANTHROPIC_API_KEY.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }

  const composio = getComposioVercelClient();
  const toolkitSlug = input.actionName.split("_")[0]?.toLowerCase();
  const session = await composio.create(getComposioEntityId(input.auth), {
    connectedAccounts: toolkitSlug ? { [toolkitSlug]: input.accountId } : undefined,
    preload: { tools: [input.actionName] },
  });
  const tools = await session.tools();

  const { text } = await generateText({
    model: anthropic(COMPOSIO_NATIVE_MODEL),
    tools,
    prompt: [
      "Execute exactly one Composio tool call with the provided tool slug and JSON arguments.",
      `tool_slug: ${input.actionName}`,
      `arguments_json: ${JSON.stringify(input.payload)}`,
      "Return a short plain-text confirmation after the tool executes.",
    ].join("\n"),
    stopWhen: stepCountIs(6),
  });

  return {
    adapter: "composio-vercel-native",
    toolSlug: input.actionName,
    sessionId: session.sessionId,
    text,
  };
}

const EMAIL_NOTIFICATION_ADAPTER: NotificationAdapter = {
  kind: "email",
  async sendApprovalPrompt(input) {
    if (config.notificationsEmailAdapter === "disabled") {
      return { ok: false, provider: "disabled", error: "Email adapter is disabled" };
    }
    const isRun = input.targetType === "workflow_run";
    const subject = isRun
      ? `Tallei draft ready: ${input.title}`
      : "Tallei found a workflow you may want to automate";
    const text = [
      input.reason,
      "",
      isRun ? `Workflow run: ${input.title}` : `Suggested workflow: ${input.title}`,
      isRun && input.draftOutput ? `Draft: ${input.draftOutput}` : `Prompt: ${input.suggestedPrompt}`,
      "",
      `Approve: ${input.approvalUrl}`,
    ].join("\n");

    const result = await sendResendEmail({
      to: input.to,
      subject,
      text,
      html: `<p>${input.reason}</p><p><strong>${input.title}</strong></p><p>${isRun && input.draftOutput ? input.draftOutput : input.suggestedPrompt}</p><p><a href=\"${input.approvalUrl}\">Approve workflow</a></p>`,
    });
    if (!result.ok) {
      return {
        ok: false,
        provider: "resend",
        error: result.error ?? `HTTP ${result.status ?? 0}`,
      };
    }
    return { ok: true, provider: "resend" };
  },
};

const WHATSAPP_NOTIFICATION_ADAPTER: NotificationAdapter = {
  kind: "whatsapp",
  async sendApprovalPrompt(input) {
    if (config.notificationsWhatsAppAdapter === "disabled") {
      return { ok: false, provider: "disabled", error: "WhatsApp adapter is disabled" };
    }
    if (config.notificationsWhatsAppAdapter === "webhook") {
      if (!config.notificationsWhatsAppWebhookUrl) {
        return { ok: false, provider: "webhook", error: "WhatsApp webhook URL is missing" };
      }
      try {
        const response = await fetch(config.notificationsWhatsAppWebhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.notificationsWhatsAppWebhookToken
              ? { authorization: `Bearer ${config.notificationsWhatsAppWebhookToken}` }
              : {}),
          },
          body: JSON.stringify({
            to: input.to,
            message: [
              input.targetType === "workflow_run"
                ? "Tallei has a workflow draft ready:"
                : "Tallei found a recurring workflow:",
              "",
              input.title,
              "",
              input.reason,
              "",
              input.targetType === "workflow_run" && input.draftOutput ? input.draftOutput : "",
              input.targetType === "workflow_run" && input.draftOutput ? "" : "",
              `Approve: ${input.approvalUrl}`,
            ].join("\n"),
            metadata: {
              targetType: input.targetType,
              targetId: input.targetId,
            },
          }),
        });
        const body = await response.text().catch(() => "");
        if (!response.ok) {
          return { ok: false, provider: "webhook", error: `HTTP ${response.status}: ${body}` };
        }
        return { ok: true, provider: "webhook" };
      } catch (error) {
        return { ok: false, provider: "webhook", error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      ok: false,
      provider: config.notificationsWhatsAppAdapter,
      error: `Unsupported WhatsApp adapter: ${config.notificationsWhatsAppAdapter}`,
    };
  },
};

function getNotificationAdapter(kind: NotificationChannel): NotificationAdapter {
  if (kind === "email") return EMAIL_NOTIFICATION_ADAPTER;
  if (kind === "whatsapp") return WHATSAPP_NOTIFICATION_ADAPTER;
  throw new Error(`Unsupported notification channel: ${kind}`);
}

async function recordNotificationDeliveryAttempt(input: {
  auth: AuthContext;
  channel: NotificationChannel;
  targetType: ApprovalTargetType;
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

async function listEnabledNotificationChannels(auth: AuthContext): Promise<NotificationChannelConfig[]> {
  const result = await pool.query<{
    kind: string;
    destination: string;
  }>(
    `SELECT kind, destination
     FROM notification_channels
     WHERE tenant_id = $1
       AND user_id = $2
       AND enabled = TRUE
     ORDER BY
       CASE kind
         WHEN 'whatsapp' THEN 0
         WHEN 'email' THEN 1
         ELSE 9
       END,
       created_at ASC`,
    [auth.tenantId, auth.userId]
  );
  return result.rows
    .filter((row): row is { kind: NotificationChannel; destination: string } =>
      (row.kind === "email" || row.kind === "whatsapp") && typeof row.destination === "string" && row.destination.length > 0
    )
    .map((row) => ({ kind: row.kind, destination: row.destination }));
}

async function composioRequest<T>(input: {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<T> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }
  const method = input.method ?? "GET";
  const response = await fetch(`${config.composioBaseUrl}${input.path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.composioApiKey,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(`Composio request failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data as T;
}

export async function listComposioToolkits(): Promise<
  Array<{
    slug: string;
    name: string;
    description: string;
    logo: string;
    category?: string;
  }>
> {
  if (!isComposioConfigured()) {
    return [];
  }

  type ToolkitRow = {
    slug?: string;
    name?: string;
    meta?: { description?: string; logo?: string };
    description?: string;
    logo?: string;
  };

  const normalizeItems = (items: unknown): ToolkitRow[] =>
    Array.isArray(items)
      ? items.filter((item): item is ToolkitRow => Boolean(item) && typeof item === "object")
      : [];

  try {
    const composio = getComposioVercelClient() as unknown as {
      toolkits?: { list?: (args?: Record<string, unknown>) => Promise<unknown> };
    };
    if (composio.toolkits?.list) {
      const sdkResponse = await composio.toolkits.list({});
      const asRecord = toObjectRecord(sdkResponse);
      const sdkItems = normalizeItems(asRecord.items);
      if (sdkItems.length > 0) {
        return sdkItems.map((item) => ({
          slug: item.slug ?? "",
          name: item.name ?? item.slug ?? "",
          description: item.meta?.description ?? item.description ?? "",
          logo: item.meta?.logo ?? item.logo ?? "",
        })).filter((item) => item.slug.length > 0);
      }
    }
  } catch (error) {
    console.warn("[workflow] composio toolkits sdk list failed:", error);
  }

  const fallbackPaths = ["/api/v3/toolkits", "/api/v3.1/toolkits"];
  for (const path of fallbackPaths) {
    try {
      const data = await composioRequest<{ items?: ToolkitRow[] }>({ path });
      const items = normalizeItems(data.items);
      if (items.length === 0) continue;
      return items.map((item) => ({
        slug: item.slug ?? "",
        name: item.name ?? item.slug ?? "",
        description: item.meta?.description ?? item.description ?? "",
        logo: item.meta?.logo ?? item.logo ?? "",
      })).filter((item) => item.slug.length > 0);
    } catch (error) {
      console.warn(`[workflow] composio toolkit fallback failed for ${path}:`, error);
    }
  }

  return [];
}

const COMPOSIO_ADAPTER: ConnectorAdapter = {
  provider: "composio",
  async startAuthSession(input) {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    let setupUrl: string | null = null;
    let externalSessionId: string | null = null;
    const appKey = normalizeComposioAppKey(input.appKey ?? inferComposioAppKey(input.requiredScopes));

    if (isComposioConfigured()) {
      try {
        if (config.composioAuthConfigId) {
          const request = await createComposioConnectLink({
            auth: input.auth,
            authConfigId: config.composioAuthConfigId,
            redirectUri: input.redirectUri ?? null,
          });
          if (request.redirectUrl) {
            setupUrl = request.redirectUrl;
          }
          externalSessionId = request.id;
        } else {
          const request = await createComposioToolkitAuthorizeLink({
            auth: input.auth,
            toolkitSlug: appKey,
            redirectUri: input.redirectUri ?? null,
          });
          if (request.redirectUrl) {
            setupUrl = request.redirectUrl;
          }
          externalSessionId = request.id;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (appKey === "resend") {
          throw new Error(
            `Failed to start Resend auth in Composio. Ensure a Resend auth config exists in Composio for this project and uses your Resend API key auth. Underlying error: ${message}`
          );
        }
        if (config.composioStrictMode) {
          throw error;
        }
        console.warn("[workflow] composio auth link fallback:", error);
      }
    } else if (config.composioStrictMode) {
      throw new Error("Composio strict mode enabled but API credentials are missing");
    }

    if (!setupUrl) {
      throw new Error(`Failed to create Composio connect link for app "${appKey}". Check Composio toolkit auth setup.`);
    }

    await pool.query(
      `INSERT INTO connector_auth_sessions
       (id, tenant_id, user_id, provider, status, setup_url, required_scopes, expires_at, metadata_json)
       VALUES ($1, $2, $3, $4, 'auth_started', $5, $6::jsonb, $7::timestamptz, $8::jsonb)`,
      [
        sessionId,
        input.auth.tenantId,
        input.auth.userId,
        input.providerKey,
        setupUrl as string,
        JSON.stringify(input.requiredScopes),
        expiresAt,
        JSON.stringify({
          redirectUri: input.redirectUri ?? null,
          adapter: "composio",
          appKey,
          composio: {
            externalSessionId,
            configured: isComposioConfigured(),
          },
        }),
      ]
    );

    return { sessionId, setupUrl, expiresAt };
  },
  async getConnectionStatus(input) {
    if (isComposioConfigured()) {
      try {
        const composio = getComposioVercelClient();
        const accounts = await composio.connectedAccounts.list({
          userIds: [getComposioEntityId(input.auth)],
          toolkitSlugs: [input.providerKey],
        });
        const items = Array.isArray(accounts.items) ? accounts.items : [];
        const hasActive = items.some((item) => {
          const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
          return status === "active" || status === "connected" || status === "enabled";
        });
        if (hasActive) return "connected";
      } catch (error) {
        if (config.composioStrictMode) throw error;
        console.warn("[workflow] composio status lookup fallback:", error);
      }
    }

    const result = await pool.query<{ status: ConnectorSetupState }>(
      `SELECT status
       FROM connector_accounts
       WHERE tenant_id = $1
         AND user_id = $2
         AND provider = $3
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.auth.tenantId, input.auth.userId, input.providerKey]
    );
    return result.rows[0]?.status ?? "missing";
  },
  async listAvailableTools() {
    return [
      { name: "send_email", description: "Send email through connected provider" },
      { name: "create_calendar_event", description: "Create calendar event" },
      { name: "post_slack_message", description: "Post message to Slack" },
    ];
  },
  async executeAction(input) {
    let responsePayload: Record<string, unknown> = { mocked: true, adapter: "composio" };
    let status: "completed" | "failed" = "completed";
    if (isComposioConfigured()) {
      try {
        const nativeResult = await tryRunComposioNativeTool({
          auth: input.auth,
          actionName: input.actionName,
          payload: input.payload,
          accountId: input.accountId,
        });
        const composioResponse = nativeResult ?? await composioRequest<Record<string, unknown>>({
          path: `/api/v3.1/tools/execute/${encodeURIComponent(input.actionName)}`,
          method: "POST",
          body: {
            connected_account_id: input.accountId,
            user_id: getComposioEntityId(input.auth),
            arguments: input.payload,
          },
        });
        responsePayload = {
          adapter: nativeResult ? "composio-vercel-native" : "composio",
          result: composioResponse,
        };
      } catch (error) {
        if (config.composioStrictMode) {
          throw error;
        }
        status = "failed";
        responsePayload = {
          adapter: "composio",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (config.composioStrictMode) {
      throw new Error("Composio strict mode enabled but API credentials are missing");
    }

    await pool.query(
      `INSERT INTO connector_action_events
       (id, tenant_id, user_id, provider, connector_account_id, action_name, idempotency_key, status, request_json, response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       ON CONFLICT (tenant_id, user_id, idempotency_key)
       DO NOTHING`,
      [
        randomUUID(),
        input.auth.tenantId,
        input.auth.userId,
        input.providerKey,
        input.accountId,
        input.actionName,
        input.idempotencyKey,
        status,
        JSON.stringify(input.payload),
        JSON.stringify(responsePayload),
      ]
    );

    return { ok: status === "completed", output: responsePayload };
  },
};

function selectConnectorAdapter(provider: string): ConnectorAdapter {
  if (provider === "composio") return COMPOSIO_ADAPTER;
  throw new Error(`Unsupported connector adapter provider: ${provider}`);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isResendApiKey(value: string): boolean {
  return /^re_[A-Za-z0-9_-]{16,}$/.test(value.trim());
}

async function verifyResendApiKey(apiKey: string): Promise<void> {
  const response = await fetch("https://api.resend.com/domains", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Resend key verification failed (${response.status})${body ? `: ${body}` : ""}`
    );
  }
}

function fingerprintForMessage(message: string): { fingerprint: string; title: string; prompt: string; reason: string } | null {
  const normalized = normalizeText(message);
  if (!normalized) return null;

  if (/\b(company update|newsletter|weekly update|status update)\b/.test(normalized)) {
    return {
      fingerprint: "company-update-weekly",
      title: "Weekly Company Update Draft",
      prompt: "Want me to prepare this every Friday?",
      reason: "You created similar company updates recently.",
    };
  }

  if (/\b(follow[- ]?up email|follow up email|customer follow up)\b/.test(normalized)) {
    return {
      fingerprint: "customer-followup-email",
      title: "Customer Follow-up Email Draft",
      prompt: "Want me to draft this follow-up each week?",
      reason: "You repeatedly ask for customer follow-up emails.",
    };
  }

  if (/\b(changelog|release notes|github changes)\b/.test(normalized)) {
    return {
      fingerprint: "changelog-from-code",
      title: "Weekly Changelog Draft",
      prompt: "Want me to convert recent code changes into a weekly changelog?",
      reason: "You repeatedly convert code changes into changelogs.",
    };
  }

  if (/\b(automate this|every week|recurring workflow|schedule this)\b/.test(normalized)) {
    return {
      fingerprint: createHash("sha256").update(normalized).digest("hex").slice(0, 24),
      title: "Recurring Workflow",
      prompt: "Want me to save this as a recurring workflow?",
      reason: "This request looks repeatable.",
    };
  }

  return null;
}

function computeConfidence(triggerCount: number): number {
  if (triggerCount >= 4) return 0.9;
  if (triggerCount >= 3) return 0.8;
  if (triggerCount >= 2) return 0.65;
  return 0.5;
}

export async function recordWorkflowActivity(input: {
  auth: AuthContext;
  source: string;
  activityType: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const normalized = normalizeText(input.content).slice(0, 8000);
  if (!normalized) return;

  await pool.query(
    `INSERT INTO ai_activity_events
     (id, tenant_id, user_id, source, activity_type, content_hash, content_text, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.source,
      input.activityType,
      createHash("sha256").update(normalized).digest("hex"),
      normalized,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

export async function discoverInlineWorkflowSuggestions(input: {
  auth: AuthContext;
  message: string;
  source: string;
}): Promise<WorkflowSuggestion[]> {
  const pattern = fingerprintForMessage(input.message);
  if (!pattern) return [];

  const now = new Date();
  const lookback = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();

  const existingPending = await pool.query<{ id: string }>(
    `SELECT id
     FROM workflow_suggestions
     WHERE tenant_id = $1
       AND user_id = $2
       AND fingerprint = $3
       AND status = 'pending'
     LIMIT 1`,
    [input.auth.tenantId, input.auth.userId, pattern.fingerprint]
  );
  if (existingPending.rows.length > 0) return [];

  const existingWorkflow = await pool.query<{ id: string }>(
    `SELECT id
     FROM workflows
     WHERE tenant_id = $1
       AND user_id = $2
       AND fingerprint = $3
       AND status IN ('active', 'paused')
     LIMIT 1`,
    [input.auth.tenantId, input.auth.userId, pattern.fingerprint]
  );
  if (existingWorkflow.rows.length > 0) return [];

  const dismissedCooldown = await pool.query<{ id: string }>(
    `SELECT id
     FROM workflow_suggestions
     WHERE tenant_id = $1
       AND user_id = $2
       AND fingerprint = $3
       AND status = 'dismissed'
       AND updated_at >= NOW() - interval '60 days'
     LIMIT 1`,
    [input.auth.tenantId, input.auth.userId, pattern.fingerprint]
  );
  if (dismissedCooldown.rows.length > 0) return [];

  const triggerCountResult = await pool.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM ai_activity_events
     WHERE tenant_id = $1
       AND user_id = $2
       AND created_at >= $3::timestamptz
       AND content_text ILIKE $4`,
    [input.auth.tenantId, input.auth.userId, lookback, `%${pattern.fingerprint.split("-")[0]}%`]
  );

  const triggerCount = Math.max(1, triggerCountResult.rows[0]?.cnt ?? 1);
  const confidence = computeConfidence(triggerCount);
  const shouldSuggest = triggerCount >= 3 || (/\bautomate this|every week|recurring\b/i.test(input.message) && triggerCount >= 2);
  if (!shouldSuggest) return [];

  const id = randomUUID();
  await pool.query(
    `INSERT INTO workflow_suggestions
     (id, tenant_id, user_id, fingerprint, title, reason, suggested_prompt, status, confidence, trigger_count, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)`,
    [
      id,
      input.auth.tenantId,
      input.auth.userId,
      pattern.fingerprint,
      pattern.title,
      pattern.reason,
      pattern.prompt,
      confidence,
      triggerCount,
      input.source,
    ]
  );

  return [{
    id,
    title: pattern.title,
    reason: pattern.reason,
    suggestedPrompt: pattern.prompt,
    status: "pending",
    confidence,
    fingerprint: pattern.fingerprint,
    triggerCount,
    createdAt: new Date().toISOString(),
  }];
}

export async function listWorkflowSuggestions(auth: AuthContext): Promise<WorkflowSuggestion[]> {
  const result = await pool.query<{
    id: string;
    title: string;
    reason: string;
    suggested_prompt: string;
    status: WorkflowSuggestionStatus;
    confidence: number;
    fingerprint: string;
    trigger_count: number;
    created_at: string;
  }>(
    `SELECT id, title, reason, suggested_prompt, status, confidence, fingerprint, trigger_count, created_at
     FROM workflow_suggestions
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY created_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    reason: row.reason,
    suggestedPrompt: row.suggested_prompt,
    status: row.status,
    confidence: Number(row.confidence),
    fingerprint: row.fingerprint,
    triggerCount: row.trigger_count,
    createdAt: row.created_at,
  }));
}

export async function approveWorkflowSuggestion(input: {
  auth: AuthContext;
  suggestionId: string;
  scheduleRrule?: string;
  requiresConnector?: boolean;
  connectorProvider?: string;
  connectorScopeKeys?: string[];
}): Promise<{ workflowId: string; connectorState: ConnectorSetupState; connectorAuthUrl?: string }> {
  const suggestionResult = await pool.query<{
    id: string;
    title: string;
    fingerprint: string;
    status: WorkflowSuggestionStatus;
  }>(
    `SELECT id, title, fingerprint, status
     FROM workflow_suggestions
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.suggestionId, input.auth.tenantId, input.auth.userId]
  );

  const suggestion = suggestionResult.rows[0];
  if (!suggestion) throw new Error("Workflow suggestion not found");
  if (suggestion.status !== "pending") throw new Error("Workflow suggestion is not pending");

  const workflowId = randomUUID();
  const requiresConnector = input.requiresConnector === true;
  const connectorProvider = requiresConnector ? (input.connectorProvider ?? "composio") : null;

  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, source_suggestion_id, title, fingerprint, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10::jsonb)`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      suggestion.id,
      suggestion.title,
      suggestion.fingerprint,
      input.scheduleRrule ?? "FREQ=WEEKLY;BYDAY=FR",
      requiresConnector,
      connectorProvider,
      JSON.stringify(input.connectorScopeKeys ?? []),
    ]
  );

  await pool.query(
    `UPDATE workflow_suggestions
     SET status = 'approved', updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [input.suggestionId, input.auth.tenantId, input.auth.userId]
  );

  await pool.query(
    `INSERT INTO approvals
     (id, tenant_id, user_id, target_type, target_id, channel, decision, metadata_json)
     VALUES ($1, $2, $3, 'workflow_suggestion', $4, 'chat', 'approved', $5::jsonb)`,
    [randomUUID(), input.auth.tenantId, input.auth.userId, input.suggestionId, JSON.stringify({ workflowId })]
  );

  if (!requiresConnector || !connectorProvider) {
    return { workflowId, connectorState: "not_required" };
  }

  if (connectorProvider !== "composio") {
    throw new Error("Composio is required for third-party workflow dependencies");
  }

  const adapter = selectConnectorAdapter(connectorProvider);
  const status = await adapter.getConnectionStatus({
    auth: input.auth,
    providerKey: connectorProvider,
  });

  if (status === "connected") {
    return { workflowId, connectorState: "connected" };
  }

  const authSession = await adapter.startAuthSession({
    auth: input.auth,
    providerKey: connectorProvider,
    appKey: inferComposioAppKey(input.connectorScopeKeys ?? []),
    requiredScopes: input.connectorScopeKeys ?? [],
  });

  return {
    workflowId,
    connectorState: "auth_started",
    connectorAuthUrl: authSession.setupUrl,
  };
}

export async function dismissWorkflowSuggestion(input: {
  auth: AuthContext;
  suggestionId: string;
  reason?: string;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE workflow_suggestions
     SET status = 'dismissed', updated_at = NOW(), dismissal_reason = $4
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [input.suggestionId, input.auth.tenantId, input.auth.userId, input.reason ?? null]
  );
  if ((result.rowCount ?? 0) === 0) throw new Error("Workflow suggestion not found");
}

export async function updateWorkflowSuggestion(input: {
  auth: AuthContext;
  suggestionId: string;
  title?: string;
  suggestedPrompt?: string;
}): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [input.suggestionId, input.auth.tenantId, input.auth.userId];
  if (typeof input.title === "string") {
    values.push(input.title.trim());
    fields.push(`title = $${values.length}`);
  }
  if (typeof input.suggestedPrompt === "string") {
    values.push(input.suggestedPrompt.trim());
    fields.push(`suggested_prompt = $${values.length}`);
  }
  if (fields.length === 0) return;
  values.push(new Date().toISOString());
  fields.push(`updated_at = $${values.length}::timestamptz`);

  const result = await pool.query(
    `UPDATE workflow_suggestions
     SET ${fields.join(", ")}
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    values
  );
  if ((result.rowCount ?? 0) === 0) throw new Error("Workflow suggestion not found");
}

export async function createExplicitWorkflow(input: {
  auth: AuthContext;
  title: string;
  instruction: string;
  scheduleRrule: string;
  requiresConnector?: boolean;
  connectorProvider?: string;
  connectorScopeKeys?: string[];
}): Promise<{ workflowId: string; connectorState: ConnectorSetupState; connectorAuthUrl?: string }> {
  const workflowId = randomUUID();
  const requiresConnector = input.requiresConnector === true;
  const provider = requiresConnector ? (input.connectorProvider ?? "composio") : null;

  if (provider && provider !== "composio") {
    throw new Error("Composio is required for third-party workflow dependencies");
  }

  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, title, fingerprint, instruction, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10::jsonb)`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      input.title,
      createHash("sha256").update(normalizeText(input.instruction)).digest("hex").slice(0, 24),
      input.instruction,
      input.scheduleRrule,
      requiresConnector,
      provider,
      JSON.stringify(input.connectorScopeKeys ?? []),
    ]
  );

  if (!provider) return { workflowId, connectorState: "not_required" };

  const adapter = selectConnectorAdapter(provider);
  const status = await adapter.getConnectionStatus({ auth: input.auth, providerKey: provider });
  if (status === "connected") return { workflowId, connectorState: status };

  const session = await adapter.startAuthSession({
    auth: input.auth,
    providerKey: provider,
    appKey: inferComposioAppKey(input.connectorScopeKeys ?? []),
    requiredScopes: input.connectorScopeKeys ?? [],
  });

  return { workflowId, connectorState: "auth_started", connectorAuthUrl: session.setupUrl };
}

export async function startConnectorAuth(input: {
  auth: AuthContext;
  provider: string;
  requiredScopes: string[];
  appKey?: string | null;
  redirectUri?: string | null;
}): Promise<{ sessionId: string; setupUrl: string; expiresAt: string }> {
  if (input.provider !== "composio") {
    throw new Error("Composio is required for third-party workflow dependencies");
  }
  const adapter = selectConnectorAdapter("composio");
  return adapter.startAuthSession({
    auth: input.auth,
    providerKey: input.provider,
    appKey: input.appKey ?? inferComposioAppKey(input.requiredScopes),
    redirectUri: input.redirectUri,
    requiredScopes: input.requiredScopes,
  });
}

export async function continueConnectorAuth(input: {
  auth: AuthContext;
  authSessionId: string;
  externalAccountId?: string;
  scopes?: string[];
}): Promise<{ status: ConnectorSetupState; accountId?: string }> {
  const sessionResult = await pool.query<{
    id: string;
    provider: string;
    status: ConnectorSetupState;
    expires_at: string;
    metadata_json: unknown;
  }>(
    `SELECT id, provider, status, expires_at, metadata_json
     FROM connector_auth_sessions
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.authSessionId, input.auth.tenantId, input.auth.userId]
  );
  const session = sessionResult.rows[0];
  if (!session) throw new Error("Connector auth session not found");

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await pool.query(
      `UPDATE connector_auth_sessions
       SET status = 'expired', updated_at = NOW()
       WHERE id = $1`,
      [session.id]
    );
    return { status: "expired" };
  }

  const sessionMetadata = toObjectRecord(session.metadata_json);
  const sessionAppKey = typeof sessionMetadata.appKey === "string"
    ? sessionMetadata.appKey.trim().toLowerCase()
    : null;
  const accountMetadata: Record<string, unknown> = {
    source: "manual_continue",
    adapter: "composio",
  };
  if (sessionAppKey) {
    accountMetadata.appKey = sessionAppKey;
  }

  const accountId = randomUUID();
  const accountResult = await pool.query<{ id: string }>(
    `INSERT INTO connector_accounts
     (id, tenant_id, user_id, provider, external_account_id, status, scopes_json, metadata_json)
     VALUES ($1, $2, $3, $4, $5, 'connected', $6::jsonb, $7::jsonb)
     ON CONFLICT (tenant_id, user_id, provider, external_account_id)
     DO UPDATE SET
       status = 'connected',
       scopes_json = EXCLUDED.scopes_json,
       metadata_json = COALESCE(connector_accounts.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
       updated_at = NOW()
     RETURNING id`,
    [
      accountId,
      input.auth.tenantId,
      input.auth.userId,
      session.provider,
      input.externalAccountId ?? `acct_${session.id.slice(0, 8)}`,
      JSON.stringify(input.scopes ?? []),
      JSON.stringify(accountMetadata),
    ]
  );
  const insertedAccountId = accountResult.rows[0]?.id ?? accountId;

  await pool.query(
    `UPDATE connector_auth_sessions
     SET status = 'connected', updated_at = NOW(), metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [session.id, JSON.stringify({ connectedAccountId: insertedAccountId })]
  );

  return { status: "connected", accountId: insertedAccountId };
}

export async function getConnectorAuthSession(input: {
  auth: AuthContext;
  authSessionId: string;
}): Promise<{
  id: string;
  provider: string;
  status: ConnectorSetupState;
  setupUrl: string;
  expiresAt: string;
  requiredScopes: string[];
}> {
  const result = await pool.query<{
    id: string;
    provider: string;
    status: ConnectorSetupState;
    setup_url: string;
    expires_at: string;
    required_scopes: unknown;
  }>(
    `SELECT id, provider, status, setup_url, expires_at, required_scopes
     FROM connector_auth_sessions
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.authSessionId, input.auth.tenantId, input.auth.userId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Connector auth session not found");
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    setupUrl: row.setup_url,
    expiresAt: row.expires_at,
    requiredScopes: Array.isArray(row.required_scopes)
      ? row.required_scopes.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export async function listActiveWorkflows(auth: AuthContext): Promise<WorkflowView[]> {
  const result = await pool.query<{
    id: string;
    title: string;
    fingerprint: string;
    schedule_rrule: string;
    status: string;
    requires_connector: boolean;
    connector_provider: string | null;
    connector_scope_keys: unknown;
    definition_version: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, title, fingerprint, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys, definition_version, created_at, updated_at
     FROM workflows
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT 100`,
    [auth.tenantId, auth.userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    fingerprint: row.fingerprint,
    scheduleRrule: row.schedule_rrule,
    status: row.status,
    requiresConnector: row.requires_connector,
    connectorProvider: row.connector_provider,
    connectorScopeKeys: Array.isArray(row.connector_scope_keys)
      ? row.connector_scope_keys.filter((v): v is string => typeof v === "string")
      : [],
    definitionVersion: row.definition_version,
    definition_version: row.definition_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listConnectorAccounts(auth: AuthContext): Promise<ConnectorAccountView[]> {
  const fetchRows = () => pool.query<{
    id: string;
    provider: string;
    external_account_id: string;
    status: ConnectorSetupState;
    scopes_json: unknown;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, provider, external_account_id, status, scopes_json, metadata_json, created_at, updated_at
     FROM connector_accounts
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY updated_at DESC`,
    [auth.tenantId, auth.userId]
  );
  let result = await fetchRows();

  const existingComposioExternalIds = new Set(
    result.rows
      .filter((row) => row.provider === "composio")
      .map((row) => row.external_account_id)
  );

  let backfilled = 0;
  const connectedSessions = await pool.query<{
    metadata_json: unknown;
    required_scopes: unknown;
  }>(
    `SELECT metadata_json, required_scopes
     FROM connector_auth_sessions
     WHERE tenant_id = $1
       AND user_id = $2
       AND provider = 'composio'
       AND status = 'connected'
     ORDER BY updated_at DESC
     LIMIT 200`,
    [auth.tenantId, auth.userId]
  );
  for (const session of connectedSessions.rows) {
    const metadata = toObjectRecord(session.metadata_json);
    const accountId = typeof metadata.accountId === "string"
      ? metadata.accountId
      : typeof metadata.externalAccountId === "string"
        ? metadata.externalAccountId
        : null;
    if (!accountId || existingComposioExternalIds.has(accountId)) continue;

    const sessionScopes = Array.isArray(session.required_scopes)
      ? session.required_scopes.filter((v): v is string => typeof v === "string")
      : [];
    const sessionAppKey = typeof metadata.appKey === "string"
      ? metadata.appKey.trim().toLowerCase()
      : inferComposioAppKey(sessionScopes);
    if (!sessionAppKey) continue;

    await pool.query(
      `INSERT INTO connector_accounts
       (id, tenant_id, user_id, provider, external_account_id, status, scopes_json, metadata_json)
       VALUES ($1, $2, $3, 'composio', $4, 'connected', $5::jsonb, $6::jsonb)
       ON CONFLICT (tenant_id, user_id, provider, external_account_id)
       DO UPDATE SET
         status = 'connected',
         scopes_json = EXCLUDED.scopes_json,
         metadata_json = COALESCE(connector_accounts.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
         updated_at = NOW()`,
      [
        randomUUID(),
        auth.tenantId,
        auth.userId,
        accountId,
        JSON.stringify(sessionScopes),
        JSON.stringify({
          source: "session_backfill",
          appKey: sessionAppKey,
          adapter: "composio",
        }),
      ]
    );
    existingComposioExternalIds.add(accountId);
    backfilled += 1;
  }

  if (backfilled > 0) {
    result = await fetchRows();
  }

  const unresolvedComposioAccountIds = new Set<string>();
  for (const row of result.rows) {
    const scopes = Array.isArray(row.scopes_json)
      ? row.scopes_json.filter((v): v is string => typeof v === "string")
      : [];
    const appKey = resolveConnectorAppKey({
      provider: row.provider,
      scopes,
      metadata: row.metadata_json,
    });
    if (!appKey && row.provider === "composio") {
      unresolvedComposioAccountIds.add(row.external_account_id);
    }
  }

  const appKeyByExternalAccountId = new Map<string, string>();
  if (unresolvedComposioAccountIds.size > 0) {
    const sessions = await pool.query<{ metadata_json: unknown }>(
      `SELECT metadata_json
       FROM connector_auth_sessions
       WHERE tenant_id = $1
         AND user_id = $2
         AND provider = 'composio'
       ORDER BY updated_at DESC
       LIMIT 300`,
      [auth.tenantId, auth.userId]
    );
    for (const row of sessions.rows) {
      const metadata = toObjectRecord(row.metadata_json);
      const sessionAppKey = typeof metadata.appKey === "string"
        ? metadata.appKey.trim().toLowerCase()
        : "";
      const accountId = typeof metadata.accountId === "string"
        ? metadata.accountId
        : "";
      if (sessionAppKey.length === 0 || accountId.length === 0) continue;
      if (!unresolvedComposioAccountIds.has(accountId)) continue;
      appKeyByExternalAccountId.set(accountId, sessionAppKey);
    }
  }

  return result.rows.map((row) => {
    const scopes = Array.isArray(row.scopes_json)
      ? row.scopes_json.filter((v): v is string => typeof v === "string")
      : [];
    const resolvedAppKey = resolveConnectorAppKey({
      provider: row.provider,
      scopes,
      metadata: row.metadata_json,
    });
    const appKey = resolvedAppKey
      ?? (row.provider === "composio" ? appKeyByExternalAccountId.get(row.external_account_id) ?? null : null);
    return {
      id: row.id,
      provider: row.provider,
      appKey,
      externalAccountId: row.external_account_id,
      status: row.status,
      scopes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function removeConnectorAccount(auth: AuthContext, accountId: string): Promise<void> {
  const result = await pool.query(
    `DELETE FROM connector_accounts
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING id`,
    [accountId, auth.tenantId, auth.userId]
  );

  if (result.rowCount === 0) {
    throw new Error("Connector account not found");
  }
}

export async function getResendConnectorSetup(auth: AuthContext): Promise<ResendConnectorSetupView> {
  const result = await pool.query<{
    id: string;
    status: ConnectorSetupState;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, status, metadata_json, created_at, updated_at
     FROM connector_accounts
     WHERE tenant_id = $1
       AND user_id = $2
       AND provider = 'resend'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );

  const row = result.rows[0];
  const metadata = toObjectRecord(row?.metadata_json);
  const last4Raw = typeof metadata.last4 === "string" ? metadata.last4 : null;
  const label = typeof metadata.label === "string" ? metadata.label : null;

  return {
    provider: "resend",
    status: row ? "connected" : "missing",
    portalUrl: config.resendPortalUrl,
    apiKeysUrl: config.resendApiKeysUrl,
    docsUrl: config.resendDocsUrl,
    steps: [
      "Open your Resend dashboard and create an API key with sending access.",
      "Copy the key now. Resend only shows it once.",
      "Paste the key here to connect your account securely.",
    ],
    ...(row
      ? {
          connection: {
            id: row.id,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            last4: last4Raw,
            label,
          },
        }
      : {}),
  };
}

export async function upsertResendConnector(input: {
  auth: AuthContext;
  apiKey: string;
  label?: string | null;
}): Promise<ResendConnectorSetupView> {
  const trimmed = input.apiKey.trim();
  if (!isResendApiKey(trimmed)) {
    throw new Error("Invalid Resend API key format");
  }

  await verifyResendApiKey(trimmed);

  const encryptedKey = encryptMemoryContent(trimmed);
  const last4 = trimmed.slice(-4);
  const label = (input.label ?? "").trim();
  const externalAccountId = `resend:${last4}`;
  const metadata = {
    appKey: "resend",
    authMode: "api_key",
    apiKeyCiphertext: encryptedKey,
    last4,
    ...(label ? { label } : {}),
  };

  await pool.query(
    `INSERT INTO connector_accounts
     (id, tenant_id, user_id, provider, external_account_id, status, scopes_json, metadata_json)
     VALUES ($1, $2, $3, 'resend', $4, 'connected', $5::jsonb, $6::jsonb)
     ON CONFLICT (tenant_id, user_id, provider, external_account_id)
     DO UPDATE SET
       status = 'connected',
       scopes_json = EXCLUDED.scopes_json,
       metadata_json = COALESCE(connector_accounts.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
       updated_at = NOW()`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      externalAccountId,
      JSON.stringify(["resend.send_email"]),
      JSON.stringify(metadata),
    ]
  );

  return getResendConnectorSetup(input.auth);
}

export async function removeResendConnector(auth: AuthContext, connectorId?: string): Promise<void> {
  if (connectorId) {
    const result = await pool.query(
      `DELETE FROM connector_accounts
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
         AND provider = 'resend'`,
      [connectorId, auth.tenantId, auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error("Resend connector not found");
    }
    return;
  }

  await pool.query(
    `DELETE FROM connector_accounts
     WHERE tenant_id = $1
       AND user_id = $2
       AND provider = 'resend'`,
    [auth.tenantId, auth.userId]
  );
}

export async function createWorkflowRun(input: {
  auth: AuthContext;
  workflowId: string;
  runMode: "scheduled" | "manual";
  scheduledFor?: string | null;
}): Promise<WorkflowRunView> {
  const workflowResult = await pool.query<{
    id: string;
    title: string;
    fingerprint: string;
    schedule_rrule: string;
    requires_connector: boolean;
    connector_provider: string | null;
    connector_scope_keys: unknown;
    instruction: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, title, fingerprint, schedule_rrule, requires_connector, connector_provider, connector_scope_keys, instruction, status, created_at, updated_at
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.workflowId, input.auth.tenantId, input.auth.userId]
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error("Workflow not found");

  let connectorActionStatus = "not_required";
  if (workflow.requires_connector) {
    if (workflow.connector_provider !== "composio") {
      throw new Error("Composio is required for third-party workflow dependencies");
    }
    const connectorState = await COMPOSIO_ADAPTER.getConnectionStatus({
      auth: input.auth,
      providerKey: "composio",
    });
    connectorActionStatus = connectorState === "connected" ? "pending" : "missing";
  }

  const runId = randomUUID();
  const runStatus = "waiting_for_approval";
  const draftOutput = workflow.instruction
    ? `Draft for ${workflow.title}\n\n${workflow.instruction}\n\nReview and approve before any external action runs.`
    : `Draft generated for ${workflow.title}. Review and approve before any external action runs.`;
  const sdkRunId = isWorkflowSdkEnabled()
    ? await createWorkflowSdkRun({
      workflowName: WORKFLOW_DEFINITIONS.WORKFLOW_RUN,
      workflowInput: workflowRunWorkflowInputSchema.parse({
        runId,
        workflowId: workflow.id,
        runMode: input.runMode,
        scheduledFor: input.scheduledFor ?? null,
      }),
      executionContext: {
        tenantId: input.auth.tenantId,
        userId: input.auth.userId,
      },
    })
    : null;

  await pool.query(
    `INSERT INTO workflow_runs
     (id, tenant_id, user_id, workflow_id, run_mode, status, scheduled_for, draft_output, connector_action_status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10::jsonb)`,
    [
      runId,
      input.auth.tenantId,
      input.auth.userId,
      workflow.id,
      input.runMode,
      runStatus,
      input.scheduledFor ?? null,
      draftOutput,
      connectorActionStatus,
      JSON.stringify({
        sdk_run_id: sdkRunId,
      }),
    ]
  );

  await pool.query(
    `INSERT INTO workflow_run_steps
     (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json)
     VALUES ($1, $2, $3, $4, 'generate_draft', $5, 'completed', $6::jsonb, $7::jsonb)`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      runId,
      `${runId}:generate_draft`,
      JSON.stringify({ instruction: workflow.instruction ?? null }),
      JSON.stringify({ draft: draftOutput }),
    ]
  );

  if (sdkRunId) {
    await pool.query(
      `INSERT INTO workflow_run_steps
       (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json)
       VALUES ($1, $2, $3, $4, 'workflow_sdk_handoff', $5, 'completed', $6::jsonb, $7::jsonb)
       ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.auth.tenantId,
        input.auth.userId,
        runId,
        `${runId}:workflow_sdk_handoff`,
        JSON.stringify({ targetWorld: config.workflowTargetWorld, sdkRunId }),
        JSON.stringify({ accepted: true, sdkRunId }),
      ]
    );
  }

  const createdRun = await getWorkflowRun(input.auth, workflow.id, runId);
  if (input.runMode === "scheduled") {
    const channels = await listEnabledNotificationChannels(input.auth);
    const selectedChannel = channels[0];
    if (selectedChannel) {
      await sendWorkflowRunApprovalNotification({
        auth: input.auth,
        run: createdRun,
        workflow: {
          id: workflow.id,
          title: workflow.title,
          fingerprint: workflow.fingerprint,
          scheduleRrule: workflow.schedule_rrule,
          status: workflow.status,
          requiresConnector: workflow.requires_connector,
          connectorProvider: workflow.connector_provider,
          connectorScopeKeys: Array.isArray(workflow.connector_scope_keys)
            ? workflow.connector_scope_keys.filter((v): v is string => typeof v === "string")
            : [],
          createdAt: workflow.created_at,
          updatedAt: workflow.updated_at,
        },
        to: selectedChannel.destination,
        channel: selectedChannel.kind,
      }).catch((error) => console.error("[workflow] failed to send run approval notification:", error));
    }
  }

  return createdRun;
}

export async function getWorkflowRun(
  auth: AuthContext,
  workflowId: string,
  runId: string,
  options?: { includeSdkDetails?: boolean }
): Promise<WorkflowRunView> {
  const result = await pool.query<{
    id: string;
    workflow_id: string;
    status: string;
    run_mode: string;
    scheduled_for: string | null;
    created_at: string;
    updated_at: string;
    draft_output: string | null;
    connector_action_status: string | null;
    metadata_json: unknown;
  }>(
    `SELECT id, workflow_id, status, run_mode, scheduled_for, created_at, updated_at, draft_output, connector_action_status, metadata_json
     FROM workflow_runs
     WHERE id = $1
       AND workflow_id = $2
       AND tenant_id = $3
       AND user_id = $4
     LIMIT 1`,
    [runId, workflowId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Workflow run not found");
  const sdkRunId = row.metadata_json && typeof row.metadata_json === "object"
    ? (row.metadata_json as Record<string, unknown>)["sdk_run_id"]
    : null;
  const workflowRun: WorkflowRunView = {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    runMode: row.run_mode,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    draftOutput: row.draft_output,
    connectorActionStatus: row.connector_action_status,
    sdkRunId: typeof sdkRunId === "string" ? sdkRunId : null,
  };

  if (options?.includeSdkDetails && workflowRun.sdkRunId && isWorkflowSdkEnabled()) {
    try {
      workflowRun.sdkRun = await getWorkflowSdkRunDetails(workflowRun.sdkRunId);
    } catch (error) {
      console.warn("[workflow-sdk] Failed to load SDK run details", {
        runId: workflowRun.id,
        sdkRunId: workflowRun.sdkRunId,
        error: error instanceof Error ? error.message : String(error),
      });
      workflowRun.sdkRun = null;
    }
  }

  return workflowRun;
}

async function getWorkflowRunById(auth: AuthContext, runId: string): Promise<WorkflowRunView> {
  const result = await pool.query<{ workflow_id: string }>(
    `SELECT workflow_id
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId]
  );
  const workflowId = result.rows[0]?.workflow_id;
  if (!workflowId) throw new Error("Workflow run not found");
  return getWorkflowRun(auth, workflowId, runId);
}

export async function approveWorkflowRunById(input: {
  auth: AuthContext;
  runId: string;
  channel?: "chat" | "email" | "whatsapp" | "portal";
}): Promise<WorkflowRunView> {
  const run = await getWorkflowRunById(input.auth, input.runId);
  return approveWorkflowRun({
    auth: input.auth,
    workflowId: run.workflowId,
    runId: input.runId,
    channel: input.channel,
  });
}

export async function skipWorkflowRunById(input: {
  auth: AuthContext;
  runId: string;
  channel?: "chat" | "email" | "whatsapp" | "portal";
}): Promise<WorkflowRunView> {
  const run = await getWorkflowRunById(input.auth, input.runId);
  return skipWorkflowRun({
    auth: input.auth,
    workflowId: run.workflowId,
    runId: input.runId,
    channel: input.channel,
  });
}

export async function listWorkflowRuns(auth: AuthContext, workflowId: string): Promise<WorkflowRunView[]> {
  const result = await pool.query<{
    id: string;
    workflow_id: string;
    status: string;
    run_mode: string;
    scheduled_for: string | null;
    created_at: string;
    updated_at: string;
    draft_output: string | null;
    connector_action_status: string | null;
    metadata_json: unknown;
  }>(
    `SELECT id, workflow_id, status, run_mode, scheduled_for, created_at, updated_at, draft_output, connector_action_status, metadata_json
     FROM workflow_runs
     WHERE workflow_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at DESC
     LIMIT 100`,
    [workflowId, auth.tenantId, auth.userId]
  );

  return result.rows.map((row) => {
    const sdkRunId = row.metadata_json && typeof row.metadata_json === "object"
      ? (row.metadata_json as Record<string, unknown>)["sdk_run_id"]
      : null;
    return {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      runMode: row.run_mode,
      scheduledFor: row.scheduled_for,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      draftOutput: row.draft_output,
      connectorActionStatus: row.connector_action_status,
      sdkRunId: typeof sdkRunId === "string" ? sdkRunId : null,
    };
  });
}

export async function approveWorkflowRun(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  channel?: "chat" | "email" | "whatsapp" | "portal";
}): Promise<WorkflowRunView> {
  const run = await getWorkflowRun(input.auth, input.workflowId, input.runId);
  if (run.status !== "waiting_for_approval") {
    throw new Error("Workflow run is not waiting for approval");
  }

  const workflowResult = await pool.query<{
    requires_connector: boolean;
    connector_provider: string | null;
  }>(
    `SELECT requires_connector, connector_provider
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [input.workflowId, input.auth.tenantId, input.auth.userId]
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error("Workflow not found");

  let connectorStatus = "not_required";
  if (workflow.requires_connector) {
    if (workflow.connector_provider !== "composio") {
      throw new Error("Composio is required for third-party workflow dependencies");
    }

    const connector = await pool.query<{ id: string; provider: string; status: ConnectorSetupState }>(
      `SELECT id, provider, status
       FROM connector_accounts
       WHERE tenant_id = $1
         AND user_id = $2
         AND provider = 'composio'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.auth.tenantId, input.auth.userId]
    );

    const account = connector.rows[0];
    if (!account || account.status !== "connected") {
      throw new Error("Missing connected Composio account for this workflow");
    }

    const adapter = selectConnectorAdapter("composio");
    const idempotencyKey = `${run.id}:connector_execute`;
    let connectorResult: { ok: boolean; output: Record<string, unknown> };
    try {
      connectorResult = await adapter.executeAction({
        auth: input.auth,
        providerKey: "composio",
        accountId: account.id,
        actionName: "workflow.execute",
        payload: { workflowId: input.workflowId, runId: run.id },
        idempotencyKey,
      });
    } catch (error) {
      await pool.query(
        `INSERT INTO workflow_run_steps
         (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, error_json, completed_at)
         VALUES ($1, $2, $3, $4, 'execute_connector_action', $5, 'failed', $6::jsonb, $7::jsonb, NOW())
         ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.auth.tenantId,
          input.auth.userId,
          run.id,
          idempotencyKey,
          JSON.stringify({ workflowId: input.workflowId }),
          JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        ]
      );
      throw error;
    }
    if (!connectorResult.ok) {
      throw new Error("Composio action execution failed");
    }
    connectorStatus = "completed";

    await pool.query(
      `INSERT INTO workflow_run_steps
       (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json)
       VALUES ($1, $2, $3, $4, 'execute_connector_action', $5, 'completed', $6::jsonb, $7::jsonb)
       ON CONFLICT (tenant_id, user_id, idempotency_key)
       DO NOTHING`,
      [
        randomUUID(),
        input.auth.tenantId,
        input.auth.userId,
        run.id,
        idempotencyKey,
        JSON.stringify({ workflowId: input.workflowId }),
        JSON.stringify({ adapter: "composio", status: "completed" }),
      ]
    );
  }

  await pool.query(
    `UPDATE workflow_runs
     SET status = 'completed',
         connector_action_status = $5,
         updated_at = NOW()
     WHERE id = $1
       AND workflow_id = $2
       AND tenant_id = $3
       AND user_id = $4`,
    [run.id, input.workflowId, input.auth.tenantId, input.auth.userId, connectorStatus]
  );

  if (run.sdkRunId) {
    await completeWorkflowSdkRun(run.sdkRunId, {
      workflowId: input.workflowId,
      runId: run.id,
      connectorStatus,
      decision: "approved",
    });
  }

  await pool.query(
    `INSERT INTO workflow_run_steps
     (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json, completed_at)
     VALUES ($1, $2, $3, $4, 'approval_decision', $5, 'completed', $6::jsonb, $7::jsonb, NOW())
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      run.id,
      `${run.id}:approval_decision:approved`,
      JSON.stringify({ channel: input.channel ?? "chat", workflowId: input.workflowId }),
      JSON.stringify({ decision: "approved", connectorStatus }),
    ]
  );

  await pool.query(
    `INSERT INTO approvals
     (id, tenant_id, user_id, target_type, target_id, channel, decision, metadata_json)
     VALUES ($1, $2, $3, 'workflow_run', $4, $5, 'approved', $6::jsonb)`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      run.id,
      input.channel ?? "chat",
      JSON.stringify({ workflowId: input.workflowId }),
    ]
  );

  return getWorkflowRun(input.auth, input.workflowId, run.id);
}

export async function skipWorkflowRun(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  channel?: "chat" | "email" | "whatsapp" | "portal";
}): Promise<WorkflowRunView> {
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'skipped',
         updated_at = NOW()
     WHERE id = $1
       AND workflow_id = $2
       AND tenant_id = $3
       AND user_id = $4`,
    [input.runId, input.workflowId, input.auth.tenantId, input.auth.userId]
  );

  await pool.query(
    `INSERT INTO approvals
     (id, tenant_id, user_id, target_type, target_id, channel, decision, metadata_json)
     VALUES ($1, $2, $3, 'workflow_run', $4, $5, 'skipped', $6::jsonb)`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.channel ?? "chat",
      JSON.stringify({ workflowId: input.workflowId }),
    ]
  );

  const run = await getWorkflowRun(input.auth, input.workflowId, input.runId);
  if (run.sdkRunId) {
    await cancelWorkflowSdkRun(run.sdkRunId);
  }

  await pool.query(
    `INSERT INTO workflow_run_steps
     (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json, completed_at)
     VALUES ($1, $2, $3, $4, 'approval_decision', $5, 'completed', $6::jsonb, $7::jsonb, NOW())
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      `${input.runId}:approval_decision:skipped`,
      JSON.stringify({ channel: input.channel ?? "chat", workflowId: input.workflowId }),
      JSON.stringify({ decision: "skipped" }),
    ]
  );

  return run;
}

export async function listWorkflowRunSteps(
  auth: AuthContext,
  workflowId: string,
  runId: string
): Promise<WorkflowRunStepView[]> {
  const run = await getWorkflowRun(auth, workflowId, runId);
  if (!run) return [];

  const result = await pool.query<{
    id: string;
    step_name: string;
    status: string;
    idempotency_key: string;
    input_json: unknown;
    output_json: unknown;
    error_json: unknown;
    started_at: string;
    completed_at: string | null;
    created_at: string;
  }>(
    `SELECT id, step_name, status, idempotency_key, input_json, output_json, error_json, started_at, completed_at, created_at
     FROM workflow_run_steps
     WHERE tenant_id = $1
       AND user_id = $2
       AND workflow_run_id = $3
     ORDER BY created_at ASC`,
    [auth.tenantId, auth.userId, runId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    stepName: row.step_name,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    input: row.input_json,
    output: row.output_json,
    error: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }));
}

export async function createWorkflowApprovalRequest(input: {
  auth: AuthContext;
  targetType: ApprovalTargetType;
  targetId: string;
  channel: "email" | "whatsapp";
}): Promise<{ token: string; url: string }> {
  const token = createHash("sha256").update(`${input.auth.tenantId}:${input.auth.userId}:${input.targetType}:${input.targetId}:${Date.now()}`).digest("hex");
  await pool.query(
    `INSERT INTO workflow_approval_tokens
     (token, tenant_id, user_id, target_type, target_id, channel, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + interval '7 days')`,
    [token, input.auth.tenantId, input.auth.userId, input.targetType, input.targetId, input.channel]
  );

  return {
    token,
    url: `${config.publicBaseUrl}/api/workflow-approvals/${token}`,
  };
}

export async function resolveWorkflowApprovalToken(token: string): Promise<{
  tenantId: string;
  userId: string;
  targetType: string;
  targetId: string;
  channel: string;
  expired: boolean;
  consumedAt: string | null;
} | null> {
  const result = await pool.query<{
    tenant_id: string;
    user_id: string;
    target_type: string;
    target_id: string;
    channel: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT tenant_id, user_id, target_type, target_id, channel, expires_at, consumed_at
     FROM workflow_approval_tokens
     WHERE token = $1
     LIMIT 1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    targetType: row.target_type,
    targetId: row.target_id,
    channel: row.channel,
    expired: new Date(row.expires_at).getTime() < Date.now(),
    consumedAt: row.consumed_at,
  };
}

export async function consumeWorkflowApprovalToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_approval_tokens
     SET consumed_at = NOW()
     WHERE token = $1
       AND consumed_at IS NULL`,
    [token]
  );
}

export async function sendWorkflowSuggestionEmail(input: {
  auth: AuthContext;
  suggestion: WorkflowSuggestion;
  to: string;
}): Promise<void> {
  await sendWorkflowSuggestionNotification({
    auth: input.auth,
    suggestion: input.suggestion,
    to: input.to,
    channel: "email",
  });
}

export async function sendWorkflowSuggestionWhatsApp(input: {
  auth: AuthContext;
  suggestion: WorkflowSuggestion;
  to: string;
}): Promise<void> {
  await sendWorkflowSuggestionNotification({
    auth: input.auth,
    suggestion: input.suggestion,
    to: input.to,
    channel: "whatsapp",
  });
}

export async function sendWorkflowSuggestionNotification(input: {
  auth: AuthContext;
  suggestion: WorkflowSuggestion;
  to: string;
  channel: NotificationChannel;
}): Promise<void> {
  const approval = await createWorkflowApprovalRequest({
    auth: input.auth,
    targetType: "workflow_suggestion",
    targetId: input.suggestion.id,
    channel: input.channel,
  });

  const adapter = getNotificationAdapter(input.channel);
  const maxAttempts = Math.max(1, config.notificationsDeliveryMaxAttempts);
  const baseDelayMs = Math.max(200, config.notificationsDeliveryRetryBaseMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deliveryId = randomUUID();
    const idempotencyKey = `${input.channel}:${input.suggestion.id}:${attempt}`;
    await recordNotificationDeliveryAttempt({
      auth: input.auth,
      channel: input.channel,
      targetType: "workflow_suggestion",
      targetId: input.suggestion.id,
      status: "queued",
      payload: {
        to: input.to,
        attempt,
        maxAttempts,
        approvalUrl: approval.url,
        idempotencyKey,
        deliveryId,
      },
    });

    const result = await adapter.sendApprovalPrompt({
      auth: input.auth,
      targetType: "workflow_suggestion",
      targetId: input.suggestion.id,
      approvalUrl: approval.url,
      title: input.suggestion.title,
      reason: input.suggestion.reason,
      suggestedPrompt: input.suggestion.suggestedPrompt,
      to: input.to,
    });

    if (result.ok) {
      await recordNotificationDeliveryAttempt({
        auth: input.auth,
        channel: input.channel,
        targetType: "workflow_suggestion",
        targetId: input.suggestion.id,
        status: "sent",
        payload: {
          to: input.to,
          attempt,
          provider: result.provider,
          externalMessageId: result.externalMessageId ?? null,
          idempotencyKey,
          deliveryId,
        },
      });
      return;
    }

    await recordNotificationDeliveryAttempt({
      auth: input.auth,
      channel: input.channel,
      targetType: "workflow_suggestion",
      targetId: input.suggestion.id,
      status: "failed",
      payload: {
        to: input.to,
        attempt,
        provider: result.provider,
        error: result.error ?? "unknown error",
        idempotencyKey,
        deliveryId,
      },
    });

    if (attempt < maxAttempts) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }

  throw new Error(`Failed to deliver ${input.channel} approval prompt after ${maxAttempts} attempt(s)`);
}

export async function sendWorkflowRunApprovalNotification(input: {
  auth: AuthContext;
  run: WorkflowRunView;
  workflow: WorkflowView;
  to: string;
  channel: NotificationChannel;
}): Promise<void> {
  const approval = await createWorkflowApprovalRequest({
    auth: input.auth,
    targetType: "workflow_run",
    targetId: input.run.id,
    channel: input.channel,
  });
  const adapter = getNotificationAdapter(input.channel);
  const result = await adapter.sendApprovalPrompt({
    auth: input.auth,
    targetType: "workflow_run",
    targetId: input.run.id,
    approvalUrl: approval.url,
    title: input.workflow.title,
    reason: "A scheduled workflow draft is ready for review.",
    suggestedPrompt: "Approve this run to execute the action.",
    draftOutput: input.run.draftOutput,
    to: input.to,
  });
  await recordNotificationDeliveryAttempt({
    auth: input.auth,
    channel: input.channel,
    targetType: "workflow_run",
    targetId: input.run.id,
    status: result.ok ? "sent" : "failed",
    payload: {
      to: input.to,
      provider: result.provider,
      error: result.error ?? null,
      approvalUrl: approval.url,
    },
  });
  if (!result.ok) {
    throw new Error(`Failed to deliver ${input.channel} run approval prompt: ${result.error ?? "unknown error"}`);
  }
}

export async function runDailyIntelligencePassForUser(auth: AuthContext): Promise<{
  suggestionCount: number;
}> {
  return runDailyIntelligencePassForUserInternal(auth, { skipSdkLifecycle: false });
}

export async function runDailyIntelligencePassForUserInternal(
  auth: AuthContext,
  options: { skipSdkLifecycle: boolean }
): Promise<{
  suggestionCount: number;
}> {
  return runDailyIntelligencePipeline(
    auth,
    {
      skipSdkLifecycle: options.skipSdkLifecycle,
      workflowSdkEnabled: isWorkflowSdkEnabled(),
      workflowTargetWorld: config.workflowTargetWorld,
    },
    {
      startDailySdkRun: async (resolvedAuth) => createWorkflowSdkRun({
        workflowName: WORKFLOW_DEFINITIONS.DAILY_INTELLIGENCE,
        workflowInput: dailyIntelligenceWorkflowInputSchema.parse({
          tenantId: resolvedAuth.tenantId,
          userId: resolvedAuth.userId,
        }),
        executionContext: {
          tenantId: resolvedAuth.tenantId,
          userId: resolvedAuth.userId,
        },
      }),
      completeDailySdkRun: async (sdkRunId, payload) => completeWorkflowSdkRun(sdkRunId, payload),
      runMemoryCleanupForUser,
      discoverInlineWorkflowSuggestions,
      listEnabledNotificationChannels,
      sendWorkflowSuggestionNotification,
      sendMemoryCleanupAdminEmail: async (input) => {
        await sendMemoryCleanupAdminEmail(input);
      },
    }
  );
}

async function buildMemoryCleanupSummary(auth: AuthContext): Promise<{
  staleCandidates: number;
  promotionCandidates: number;
  duplicateHashCandidates: number;
}> {
  try {
    const result = await pool.query<{
      stale_candidates: number;
      promotion_candidates: number;
      duplicate_hash_candidates: number;
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE memory_type = 'short_term'
             AND is_pinned = FALSE
             AND COALESCE(last_referenced_at, created_at) < NOW() - interval '30 days'
         )::int AS stale_candidates,
         COUNT(*) FILTER (
           WHERE memory_type = 'short_term'
             AND reference_count >= 3
             AND deleted_at IS NULL
             AND superseded_by IS NULL
         )::int AS promotion_candidates,
         GREATEST(COUNT(*)::int - COUNT(DISTINCT content_hash)::int, 0) AS duplicate_hash_candidates
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND superseded_by IS NULL`,
      [auth.tenantId, auth.userId]
    );
    const row = result.rows[0];
    return {
      staleCandidates: row?.stale_candidates ?? 0,
      promotionCandidates: row?.promotion_candidates ?? 0,
      duplicateHashCandidates: row?.duplicate_hash_candidates ?? 0,
    };
  } catch (error) {
    console.warn("[workflow] daily memory cleanup summary failed:", error);
    return { staleCandidates: 0, promotionCandidates: 0, duplicateHashCandidates: 0 };
  }
}

export async function executeWorkflowRunSdkHandler(input: {
  auth: AuthContext;
  runId: string;
  workflowId: string;
  runMode: "scheduled" | "manual";
  scheduledFor: string | null;
}): Promise<{ deferred: true; output: Record<string, unknown> }> {
  await pool.query(
    `INSERT INTO workflow_run_steps
     (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json, completed_at)
     VALUES ($1, $2, $3, $4, 'sdk_orchestrator_dispatch', $5, 'completed', $6::jsonb, $7::jsonb, NOW())
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      `${input.runId}:sdk_orchestrator_dispatch`,
      JSON.stringify({
        workflowId: input.workflowId,
        runMode: input.runMode,
        scheduledFor: input.scheduledFor,
      }),
      JSON.stringify({
        status: "waiting_for_approval",
        message: "Run dispatched and awaiting explicit approval.",
      }),
    ]
  );

  return {
    deferred: true,
    output: {
      status: "waiting_for_approval",
      runId: input.runId,
      workflowId: input.workflowId,
    },
  };
}

export async function syncWorkflowRunStatusFromSdk(input: {
  sdkRunId: string;
  sdkStatus: WorkflowSdkRunStatus;
}): Promise<void> {
  await pool.query(
    `UPDATE workflow_runs
     SET status = CASE
         WHEN $2 = 'failed' THEN 'failed'
         WHEN $2 = 'cancelled' THEN CASE WHEN status = 'completed' THEN status ELSE 'cancelled' END
         WHEN $2 = 'completed' THEN CASE WHEN status = 'skipped' THEN status ELSE 'completed' END
         WHEN $2 IN ('pending', 'running')
           THEN CASE
             WHEN status IN ('completed', 'skipped', 'failed', 'cancelled') THEN status
             ELSE 'waiting_for_approval'
           END
         ELSE status
       END,
       metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
       updated_at = NOW()
     WHERE metadata_json ->> 'sdk_run_id' = $1`,
    [
      input.sdkRunId,
      input.sdkStatus,
      JSON.stringify({
        workflow_sdk_status: {
          status: input.sdkStatus,
          observedAt: new Date().toISOString(),
        },
      }),
    ]
  );
}

export function verifyComposioWebhookSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  if (!config.composioWebhookSecret) return true;
  if (!rawBody || !signatureHeader) return false;
  const expected = createHmac("sha256", config.composioWebhookSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.replace(/^sha256=/i, "").trim();
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleComposioWebhook(payload: unknown): Promise<{ ok: true; processed: boolean }> {
  if (!payload || typeof payload !== "object") {
    return { ok: true, processed: false };
  }

  const event = payload as Record<string, unknown>;
  const eventType = typeof event.type === "string"
    ? event.type
    : typeof event.event === "string"
      ? event.event
      : "";
  const data = (event.data && typeof event.data === "object") ? event.data as Record<string, unknown> : event;

  const talleiAuthSessionId = (
    typeof data["talleiAuthSessionId"] === "string"
      ? data["talleiAuthSessionId"]
      : (data.metadata && typeof data.metadata === "object" && typeof (data.metadata as Record<string, unknown>)["talleiAuthSessionId"] === "string")
        ? String((data.metadata as Record<string, unknown>)["talleiAuthSessionId"])
        : null
  );

  if (!talleiAuthSessionId) {
    return { ok: true, processed: false };
  }

  const accountId = typeof data["connectedAccountId"] === "string"
    ? data["connectedAccountId"]
    : typeof data["id"] === "string"
      ? data["id"]
      : `composio-${randomUUID()}`;
  const scopes = Array.isArray(data["scopes"]) ? data["scopes"].filter((v): v is string => typeof v === "string") : [];
  const status = String(data["status"] ?? "").toLowerCase();
  const isConnected = eventType.includes("connected") || status === "connected" || status === "active";
  const isRevoked = eventType.includes("revoked") || status === "revoked" || status === "disabled";

  const sessionResult = await pool.query<{
    tenant_id: string;
    user_id: string;
    provider: string;
    metadata_json: unknown;
  }>(
    `SELECT tenant_id, user_id, provider, metadata_json
     FROM connector_auth_sessions
     WHERE id = $1
     LIMIT 1`,
    [talleiAuthSessionId]
  );
  const session = sessionResult.rows[0];
  if (!session) {
    return { ok: true, processed: false };
  }
  const sessionMetadata = toObjectRecord(session.metadata_json);
  const sessionAppKey = typeof sessionMetadata.appKey === "string"
    ? sessionMetadata.appKey.trim().toLowerCase()
    : null;

  const nextStatus: ConnectorSetupState = isRevoked ? "revoked" : isConnected ? "connected" : "auth_started";
  await pool.query(
    `UPDATE connector_auth_sessions
     SET status = $2,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      talleiAuthSessionId,
      nextStatus === "connected" ? "connected" : nextStatus === "revoked" ? "revoked" : "auth_started",
      JSON.stringify({
        composioWebhookEvent: eventType || "unknown",
        accountId,
      }),
    ]
  );

  if (isConnected || isRevoked) {
    await pool.query(
      `INSERT INTO connector_accounts
       (id, tenant_id, user_id, provider, external_account_id, status, scopes_json, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (tenant_id, user_id, provider, external_account_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         scopes_json = EXCLUDED.scopes_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = NOW()`,
      [
        randomUUID(),
        session.tenant_id,
        session.user_id,
        session.provider,
        accountId,
        isRevoked ? "revoked" : "connected",
        JSON.stringify(scopes),
        JSON.stringify({
          source: "composio_webhook",
          adapter: "composio",
          ...(sessionAppKey ? { appKey: sessionAppKey } : {}),
          eventType,
        }),
      ]
    );
  }

  return { ok: true, processed: true };
}

let dailyWorkerTimer: ReturnType<typeof setInterval> | null = null;

export function startDailyIntelligenceWorker(): void {
  if (!config.dailyIntelligenceWorkerEnabled) return;
  if (dailyWorkerTimer) return;

  const pollMs = Math.max(config.dailyIntelligenceWorkerPollMs, 60_000);
  dailyWorkerTimer = setInterval(() => {
    void runDailyIntelligenceWorkerTick();
  }, pollMs);
  dailyWorkerTimer.unref?.();
  void runDailyIntelligenceWorkerTick();
}

export function stopDailyIntelligenceWorker(): void {
  if (!dailyWorkerTimer) return;
  clearInterval(dailyWorkerTimer);
  dailyWorkerTimer = null;
}

async function runDailyIntelligenceWorkerTick(): Promise<void> {
  const users = await pool.query<{ tenant_id: string; user_id: string; plan: AuthContext["plan"] }>(
    `SELECT e.tenant_id, e.user_id, s.plan
     FROM ai_activity_events e
     JOIN subscriptions s
       ON s.tenant_id = e.tenant_id
     WHERE e.created_at >= NOW() - interval '7 days'
       AND s.status <> 'expired'
       AND s.plan <> 'free'
       AND EXISTS (
         SELECT 1
         FROM memory_records mr
         WHERE mr.tenant_id = e.tenant_id
           AND mr.user_id = e.user_id
           AND mr.deleted_at IS NULL
           AND mr.superseded_by IS NULL
       )
     GROUP BY e.tenant_id, e.user_id, s.plan
     ORDER BY MAX(e.created_at) DESC
     LIMIT $1`,
    [config.dailyIntelligenceWorkerBatchSize]
  );

  for (const row of users.rows) {
    const auth: AuthContext = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      authMode: "internal",
      plan: row.plan,
    };
    try {
      await runDailyIntelligencePassForUser(auth);
    } catch (error) {
      console.error("[workflow] daily intelligence worker failed:", error);
    }
  }
}

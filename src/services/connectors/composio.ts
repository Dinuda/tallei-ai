import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { generateText, stepCountIs } from "ai";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { encryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { pool } from "../../infrastructure/db/index.js";
import type { ConnectorActionRisk } from "../loop-engine/spec-contracts.js";
import {
  formatResendFromAddress,
  resendApiRequest,
  resolveResendCredentials,
} from "../notifications/resend-email.js";

export type ConnectorSetupState =
  | "not_required"
  | "missing"
  | "auth_started"
  | "connected"
  | "expired"
  | "revoked"
  | "failed";

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

export interface ComposioActionView {
  toolkit: string;
  actionSlug: string;
  name: string;
  description: string;
  risk: ConnectorActionRisk;
  inputSchema: Record<string, unknown>;
}

export interface ConnectorActionResult {
  ok: boolean;
  provider: "composio";
  toolkit: string;
  actionSlug: string;
  connectorAccountId: string;
  idempotencyKey: string;
  output: Record<string, unknown>;
  replayed?: boolean;
}

export interface ConnectorDeliveryActionCandidate extends ComposioActionView {
  toolRef: string;
  score: number;
  reason: string;
}

interface ConnectorAdapter {
  provider: "composio";
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
  executeAction(input: {
    auth: AuthContext;
    providerKey: string;
    accountId: string;
    actionName: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; output: Record<string, unknown> }>;
}

function getComposioEntityId(auth: AuthContext): string {
  return `${config.composioEntityPrefix}:${auth.tenantId}:${auth.userId}`;
}

export function inferComposioAppKey(scopes: string[]): string {
  const first = scopes.find((scope) => scope.trim().length > 0)?.trim().toLowerCase();
  if (!first) return "gmail";
  if (first.startsWith("https://www.googleapis.com/auth/")) {
    const service = first.replace("https://www.googleapis.com/auth/", "").split(".")[0];
    if (service === "gmail" || service === "mail") return "gmail";
    if (service === "calendar") return "googlecalendar";
    if (service === "drive" || service === "docs" || service === "sheets" || service === "slides") return "google";
    return service || "gmail";
  }
  if (first.includes("google.com") || first.includes("googleapis.com")) {
    if (first.includes("mail")) return "gmail";
    if (first.includes("calendar")) return "googlecalendar";
    if (first.includes("drive")) return "google";
    return "google";
  }
  return first.split(/[.:/]/)[0] || "gmail";
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolveConnectorAppKey(input: { provider: string; scopes: string[]; metadata: unknown }): string | null {
  const metadata = toObjectRecord(input.metadata);
  const metadataAppKey = typeof metadata.appKey === "string" ? metadata.appKey.trim().toLowerCase() : "";
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

function classifyComposioAction(value: {
  slug: string;
  name?: string | null;
  description?: string | null;
}): ConnectorActionRisk {
  const text = `${value.slug} ${value.name ?? ""} ${value.description ?? ""}`.toLowerCase();
  if (/\b(delete|remove|destroy|revoke|disable|archive|trash|purge)\b/.test(text)) return "destructive";
  if (/\b(send|reply|forward|post|publish|broadcast|invite|message|email|sms|notify|schedule)\b/.test(text)) return "send";
  if (/\b(create|update|edit|patch|write|add|set|insert|upload|move|assign|comment|merge|close|open)\b/.test(text)) return "write";
  return "read";
}

function actionSearchText(action: Pick<ComposioActionView, "toolkit" | "actionSlug" | "name" | "description">): string {
  return `${action.toolkit} ${action.actionSlug} ${action.name} ${action.description}`.toLowerCase();
}

export function isDraftOnlyComposioAction(action: Pick<ComposioActionView, "toolkit" | "actionSlug" | "name" | "description">): boolean {
  return /\bdraft\b|create[_ -]?draft|email[_ -]?draft/.test(actionSearchText(action));
}

function newsletterProviderScore(toolkit: string): number {
  const key = normalizeComposioAppKey(toolkit);
  if (key === "resend") return 100;
  if (["mailchimp", "mailerlite", "beehiiv", "convertkit", "sendgrid", "mailgun", "postmark", "brevo", "customerio"].includes(key)) return 90;
  if (["gmail", "outlook"].includes(key)) return 35;
  if (/\b(mail|email|newsletter|campaign|marketing)\b/.test(key)) return 55;
  return 0;
}

export function scoreComposioActionForDelivery(input: {
  action: ComposioActionView;
  target: "subscriber_list" | "team_email" | "operator" | "none";
}): ConnectorDeliveryActionCandidate | null {
  if (input.target === "none") return null;
  if (input.action.risk !== "send") return null;
  if (isDraftOnlyComposioAction(input.action)) return null;
  const text = actionSearchText(input.action);
  if (/\b(cancel|delete|remove|revoke|disable|unsubscribe|suppress|bounce|webhook|domain|api[_ -]?key)\b/.test(text)) return null;
  const hasSendSignal = /\b(send|broadcast|campaign|email|message|mail)\b/.test(text);
  if (!hasSendSignal) return null;

  let score = newsletterProviderScore(input.action.toolkit);
  if (/\bbroadcast|campaign|audience|segment|newsletter|contact\b/.test(text)) score += 25;
  if (/\bsend[_ -]?email|email[_ -]?send|send\b/.test(text)) score += 15;
  if (input.target === "subscriber_list" && ["gmail", "outlook"].includes(normalizeComposioAppKey(input.action.toolkit))) score -= 25;
  if (input.target !== "subscriber_list" && ["gmail", "outlook"].includes(normalizeComposioAppKey(input.action.toolkit))) score += 20;
  if (score <= 0) return null;

  return {
    ...input.action,
    toolRef: `composio.${normalizeComposioAppKey(input.action.toolkit)}.action.${input.action.actionSlug}`,
    score,
    reason: input.target === "subscriber_list"
      ? "send-capable action ranked for subscriber/newsletter delivery"
      : "send-capable action ranked for direct email delivery",
  };
}

const COMPOSIO_NATIVE_MODEL = process.env.TALLEI_CONNECTORS__COMPOSIO_NATIVE_MODEL || "claude-3-5-sonnet-latest";
let composioVercelClient: Composio<VercelProvider> | null = null;

function getComposioVercelClient(): Composio<VercelProvider> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
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
  const request = await composio.connectedAccounts.link(
    getComposioEntityId(input.auth),
    input.authConfigId,
    { allowMultiple: true, ...(input.redirectUri ? { callbackUrl: input.redirectUri } : {}) }
  );
  return {
    id: typeof request.id === "string" && request.id.length > 0 ? request.id : null,
    redirectUrl: typeof request.redirectUrl === "string" && request.redirectUrl.length > 0 ? request.redirectUrl : null,
  };
}

async function createComposioToolkitAuthorizeLink(input: {
  auth: AuthContext;
  toolkitSlug: string;
  redirectUri?: string | null;
}): Promise<{ id: string | null; redirectUrl: string | null }> {
  const composio = getComposioVercelClient();
  const authConfigs = await composio.authConfigs.list({ toolkit: input.toolkitSlug });
  let authConfigId = authConfigs.items.find((ac) => ac.status === "ENABLED")?.id;
  if (!authConfigId) {
    try {
      const toolkit = await composio.toolkits.get(input.toolkitSlug);
      const created = await composio.authConfigs.create(input.toolkitSlug, {
        type: "use_composio_managed_auth",
        name: `${toolkit.name} Auth Config`,
      });
      authConfigId = created.id;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`No enabled auth config found for toolkit "${input.toolkitSlug}" and failed to create one. Please set up an auth config in the Composio dashboard. ${msg}`);
    }
  }

  const request = await composio.connectedAccounts.link(
    getComposioEntityId(input.auth),
    authConfigId,
    { allowMultiple: true, ...(input.redirectUri ? { callbackUrl: input.redirectUri } : {}) }
  );
  return {
    id: typeof request.id === "string" && request.id.length > 0 ? request.id : null,
    redirectUrl: typeof request.redirectUrl === "string" && request.redirectUrl.length > 0 ? request.redirectUrl : null,
  };
}

async function tryRunComposioNativeTool(input: {
  auth: AuthContext;
  actionName: string;
  payload: Record<string, unknown>;
  accountId: string;
}): Promise<Record<string, unknown> | null> {
  if (!config.anthropicApiKey || !/^[A-Z0-9_]+$/.test(input.actionName) || !isComposioConfigured()) return null;
  if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
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
  return { adapter: "composio-vercel-native", toolSlug: input.actionName, sessionId: session.sessionId, text };
}

async function composioRequest<T>(input: {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<T> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const response = await fetch(`${config.composioBaseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.composioApiKey,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const text = await response.text();
  // Guard against HTML error pages (404, 500, etc.)
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) {
      throw new Error(`Composio request failed (${response.status}): non-JSON response (${contentType})`);
    }
    // Empty or non-JSON success — return empty object
    return {} as T;
  }
  const data = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) throw new Error(`Composio request failed (${response.status}): ${JSON.stringify(data)}`);
  return data as T;
}

export async function listComposioToolkits(): Promise<Array<{
  slug: string;
  name: string;
  description: string;
  logo: string;
  category?: string;
}>> {
  if (!isComposioConfigured()) return [];
  type ToolkitRow = {
    slug?: string;
    name?: string;
    meta?: { description?: string; logo?: string };
    description?: string;
    logo?: string;
  };
  const normalizeItems = (items: unknown): ToolkitRow[] =>
    Array.isArray(items) ? items.filter((item): item is ToolkitRow => Boolean(item) && typeof item === "object") : [];
  try {
    const composio = getComposioVercelClient() as unknown as {
      toolkits?: { list?: (args?: Record<string, unknown>) => Promise<unknown> };
    };
    if (composio.toolkits?.list) {
      const sdkResponse = await composio.toolkits.list({});
      const sdkItems = normalizeItems(toObjectRecord(sdkResponse).items);
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
    console.warn("[connectors] composio toolkits sdk list failed:", error);
  }
  const paths = ["/api/v3/toolkits", "/api/v3.1/toolkits"];
  let lastError: Error | null = null;
  for (const path of paths) {
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
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError) {
    console.warn(`[connectors] composio toolkit discovery failed (tried ${paths.length} paths): ${lastError.message}`);
  }
  return [];
}

function normalizeComposioAction(toolkit: string, raw: unknown): ComposioActionView | null {
  const row = toObjectRecord(raw);
  const slug = String(row.slug ?? row.name ?? row.id ?? row.action ?? "").trim();
  if (!slug) return null;
  const name = String(row.displayName ?? row.name ?? slug).trim();
  const meta = toObjectRecord(row.meta);
  const description = String(row.description ?? meta.description ?? "").trim();
  const inputSchema = toObjectRecord(row.inputSchema ?? row.parameters ?? row.schema ?? row.argsSchema);
  return {
    toolkit,
    actionSlug: slug,
    name,
    description,
    risk: classifyComposioAction({ slug, name, description }),
    inputSchema,
  };
}

export async function listComposioToolkitTools(toolkitSlug: string): Promise<ComposioActionView[]> {
  const toolkit = normalizeComposioAppKey(toolkitSlug);
  if (!isComposioConfigured()) return [];
  const normalizeItems = (items: unknown): ComposioActionView[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeComposioAction(toolkit, item))
      .filter((item): item is ComposioActionView => Boolean(item));

  try {
    const composio = getComposioVercelClient() as unknown as {
      tools?: { list?: (args?: Record<string, unknown>) => Promise<unknown> };
      toolkits?: { tools?: { list?: (args?: Record<string, unknown>) => Promise<unknown> } };
    };
    const sdkList = composio.tools?.list ?? composio.toolkits?.tools?.list;
    if (sdkList) {
      const response = await sdkList({ toolkit });
      const items = normalizeItems(toObjectRecord(response).items ?? response);
      if (items.length > 0) return items;
    }
  } catch (error) {
    console.warn(`[connectors] composio toolkit tools sdk list failed for ${toolkit}:`, error);
  }

  const paths = [
    `/api/v3.1/tools?toolkit=${encodeURIComponent(toolkit)}`,
    `/api/v3/tools?toolkit=${encodeURIComponent(toolkit)}`,
    `/api/v3.1/toolkits/${encodeURIComponent(toolkit)}/tools`,
    `/api/v3/toolkits/${encodeURIComponent(toolkit)}/tools`,
  ];
  let lastError: Error | null = null;
  for (const path of paths) {
    try {
      const data = await composioRequest<{ items?: unknown[]; tools?: unknown[] }>({ path });
      const items = normalizeItems(data.items ?? data.tools);
      if (items.length > 0) return items;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError) {
    console.warn(`[connectors] composio toolkit tools discovery failed for ${toolkit} (tried ${paths.length} paths): ${lastError.message}`);
  }
  return [];
}

function fallbackDeliveryActionsForToolkit(toolkit: string): ComposioActionView[] {
  const key = normalizeComposioAppKey(toolkit);
  if (key === "resend") {
    return [{
      toolkit: "resend",
      actionSlug: "RESEND_SEND_EMAIL",
      name: "Send Email",
      description: "Send an email using Resend.",
      risk: "send",
      inputSchema: { type: "object" },
    }];
  }
  if (key === "gmail") {
    return [{
      toolkit: "gmail",
      actionSlug: "GMAIL_SEND_EMAIL",
      name: "Send Email",
      description: "Send an email using Gmail.",
      risk: "send",
      inputSchema: { type: "object" },
    }];
  }
  return [];
}

export async function listDeliveryActionCandidates(input: {
  auth: AuthContext;
  target: "subscriber_list" | "team_email" | "operator" | "none";
}): Promise<ConnectorDeliveryActionCandidate[]> {
  if (input.target === "none") return [];
  const accounts = await listConnectorAccounts(input.auth).catch(() => []);
  const connectedToolkits = [...new Set(accounts
    .filter((account) => account.status === "connected")
    .map((account) => account.appKey?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value)))];
  const candidates: ConnectorDeliveryActionCandidate[] = [];

  for (const toolkit of connectedToolkits) {
    const discovered = await listComposioToolkitTools(toolkit).catch(() => []);
    const actions = discovered.length > 0 ? discovered : fallbackDeliveryActionsForToolkit(toolkit);
    for (const action of actions) {
      const candidate = scoreComposioActionForDelivery({ action, target: input.target });
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates.sort((a, b) => b.score - a.score || a.toolkit.localeCompare(b.toolkit));
}

export async function selectBestDeliveryAction(input: {
  auth: AuthContext;
  target: "subscriber_list" | "team_email" | "operator" | "none";
}): Promise<ConnectorDeliveryActionCandidate | null> {
  return (await listDeliveryActionCandidates(input))[0] ?? null;
}

const COMPOSIO_ADAPTER: ConnectorAdapter = {
  provider: "composio",
  async startAuthSession(input) {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const appKey = normalizeComposioAppKey(input.appKey ?? inferComposioAppKey(input.requiredScopes));
    let setupUrl: string | null = null;
    let externalSessionId: string | null = null;
    if (isComposioConfigured()) {
      try {
        const request = config.composioAuthConfigId
          ? await createComposioConnectLink({ auth: input.auth, authConfigId: config.composioAuthConfigId, redirectUri: input.redirectUri ?? null })
          : await createComposioToolkitAuthorizeLink({ auth: input.auth, toolkitSlug: appKey, redirectUri: input.redirectUri ?? null });
        setupUrl = request.redirectUrl;
        externalSessionId = request.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (appKey === "resend") {
          throw new Error(`Failed to start Resend auth in Composio. Ensure a Resend auth config exists in Composio for this project and uses your Resend API key auth. Underlying error: ${message}`);
        }
        if (config.composioStrictMode) throw error;
        console.warn("[connectors] composio auth link fallback:", error);
      }
    } else if (config.composioStrictMode) {
      throw new Error("Composio strict mode enabled but API credentials are missing");
    }
    if (!setupUrl) throw new Error(`Failed to create Composio connect link for app "${appKey}". Check Composio toolkit auth setup.`);
    await pool.query(
      `INSERT INTO connector_auth_sessions
       (id, tenant_id, user_id, provider, status, setup_url, required_scopes, expires_at, metadata_json)
       VALUES ($1, $2, $3, $4, 'auth_started', $5, $6::jsonb, $7::timestamptz, $8::jsonb)`,
      [
        sessionId,
        input.auth.tenantId,
        input.auth.userId,
        input.providerKey,
        setupUrl,
        JSON.stringify(input.requiredScopes),
        expiresAt,
        JSON.stringify({
          redirectUri: input.redirectUri ?? null,
          adapter: "composio",
          appKey,
          composio: { externalSessionId, configured: isComposioConfigured() },
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
        if (items.some((item) => ["active", "connected", "enabled"].includes(String(item.status ?? "").toLowerCase()))) {
          return "connected";
        }
      } catch (error) {
        if (config.composioStrictMode) throw error;
        console.warn("[connectors] composio status lookup fallback:", error);
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
        responsePayload = { adapter: nativeResult ? "composio-vercel-native" : "composio", result: composioResponse };
      } catch (error) {
        if (config.composioStrictMode) throw error;
        status = "failed";
        responsePayload = { adapter: "composio", error: error instanceof Error ? error.message : String(error) };
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

export function selectComposioConnectorAdapter(): ConnectorAdapter {
  return COMPOSIO_ADAPTER;
}

type ConnectedConnectorAccount = ConnectorAccountView & { metadata: Record<string, unknown> };

function isPlaceholderConnectedAccountId(accountId: string): boolean {
  const id = accountId.trim();
  if (!id) return true;
  if (/^resend:[a-z0-9]{4}$/i.test(id)) return true;
  if (id.startsWith("acct_")) return true;
  return false;
}

function isNativeApiKeyConnector(metadata: Record<string, unknown>, externalAccountId: string): boolean {
  if (metadata.authMode === "api_key") return true;
  return /^resend:[a-z0-9]{4}$/i.test(externalAccountId.trim());
}

async function getConnectedConnectorAccount(input: {
  auth: AuthContext;
  toolkit: string;
}): Promise<ConnectedConnectorAccount> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  const result = await pool.query<{
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
       AND status = 'connected'
     ORDER BY updated_at DESC`,
    [input.auth.tenantId, input.auth.userId],
  );
  for (const row of result.rows) {
    const scopes = Array.isArray(row.scopes_json)
      ? row.scopes_json.filter((value): value is string => typeof value === "string")
      : [];
    const appKey = resolveConnectorAppKey({ provider: row.provider, scopes, metadata: row.metadata_json });
    if (appKey?.trim().toLowerCase() !== toolkit) continue;
    return {
      id: row.id,
      provider: row.provider,
      appKey,
      externalAccountId: row.external_account_id,
      status: row.status,
      scopes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: toObjectRecord(row.metadata_json),
    };
  }
  throw new Error(`Connect ${toolkit} before executing connector actions`);
}

async function resolveComposioConnectedAccountId(input: {
  auth: AuthContext;
  toolkit: string;
  accountId: string;
  metadata: Record<string, unknown>;
}): Promise<string | undefined> {
  if (isNativeApiKeyConnector(input.metadata, input.accountId)) return undefined;
  if (!isPlaceholderConnectedAccountId(input.accountId)) return input.accountId;
  if (!isComposioConfigured()) return undefined;
  try {
    const composio = getComposioVercelClient();
    const accounts = await composio.connectedAccounts.list({
      userIds: [getComposioEntityId(input.auth)],
      toolkitSlugs: [normalizeComposioAppKey(input.toolkit)],
    });
    const items = Array.isArray(accounts.items) ? accounts.items : [];
    const active = items.find((item) =>
      ["active", "connected", "enabled"].includes(String(item.status ?? "").toLowerCase()),
    );
    const id = typeof active?.id === "string" ? active.id.trim() : "";
    return id || undefined;
  } catch (error) {
    console.warn("[connectors] failed to resolve composio connected account:", error);
    return undefined;
  }
}

function normalizeResendRecipients(payload: Record<string, unknown>): string[] {
  const candidates = [payload.to, payload.recipients, payload.emails, payload.subscriber_emails];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes("@")) {
      return [candidate.trim()];
    }
    if (Array.isArray(candidate)) {
      const emails = candidate
        .filter((value): value is string => typeof value === "string" && value.includes("@"))
        .map((value) => value.trim());
      if (emails.length > 0) return emails;
    }
  }
  return [];
}

async function executeNativeResendAction(input: {
  auth: AuthContext;
  actionSlug: string;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const creds = await resolveResendCredentials(input.auth);
  if (!creds) {
    throw new Error("Resend API key is not configured. Reconnect Resend in dashboard setup.");
  }
  const from = formatResendFromAddress(creds);
  const slug = input.actionSlug.toLowerCase();
  const subject = typeof input.payload.subject === "string" && input.payload.subject.trim()
    ? input.payload.subject.trim()
    : typeof input.payload.title === "string" && input.payload.title.trim()
      ? input.payload.title.trim()
      : "Newsletter";
  const html = typeof input.payload.html === "string" && input.payload.html.trim()
    ? input.payload.html.trim()
    : typeof input.payload.content === "string"
      ? input.payload.content
      : "";
  const text = typeof input.payload.text === "string" ? input.payload.text : undefined;
  if (!html && !text) throw new Error("Resend send requires email body content in the action payload.");

  if (slug.includes("broadcast")) {
    const audienceId = typeof input.payload.audience_id === "string"
      ? input.payload.audience_id
      : typeof input.payload.segment_id === "string"
        ? input.payload.segment_id
        : typeof input.payload.list_id === "string"
          ? input.payload.list_id
          : "";
    if (!audienceId) {
      throw new Error("Resend broadcast requires audience_id, segment_id, or list_id in the action payload.");
    }
    const created = await resendApiRequest({
      creds,
      path: "/broadcasts",
      body: {
        audience_id: audienceId,
        from,
        subject,
        html: html || undefined,
        text: text || (!html ? subject : undefined),
      },
    });
    if (!created.ok) throw new Error(created.error ?? "Resend broadcast create failed");
    const broadcastId = typeof created.data?.id === "string" ? created.data.id : "";
    if (!broadcastId) throw new Error("Resend broadcast create did not return an id");
    const sent = await resendApiRequest({
      creds,
      path: `/broadcasts/${broadcastId}/send`,
      body: {},
    });
    if (!sent.ok) throw new Error(sent.error ?? "Resend broadcast send failed");
    return { adapter: "resend-native", action: "broadcast", broadcastId, result: sent.data ?? created.data };
  }

  const to = normalizeResendRecipients(input.payload);
  if (to.length === 0) {
    throw new Error("Resend send requires at least one recipient (to/recipients) in the action payload.");
  }
  const sent = await resendApiRequest({
    creds,
    path: "/emails",
    body: {
      from,
      to,
      subject,
      html: html || undefined,
      text: text || (!html ? subject : undefined),
      ...(creds.replyTo ? { reply_to: creds.replyTo } : {}),
    },
  });
  if (!sent.ok) throw new Error(sent.error ?? "Resend send failed");
  return { adapter: "resend-native", action: "email", result: sent.data };
}

async function executeComposioActionDirect(input: {
  auth: AuthContext;
  toolkit: string;
  actionSlug: string;
  accountId?: string;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const composio = getComposioVercelClient() as unknown as {
    tools?: {
      execute?: (slug: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  const executeArgs = {
    userId: getComposioEntityId(input.auth),
    arguments: input.payload,
    ...(input.accountId ? { connectedAccountId: input.accountId } : {}),
  };
  if (composio.tools?.execute) {
    try {
      const result = await composio.tools.execute(input.actionSlug, executeArgs);
      return { adapter: "composio-sdk", result: toObjectRecord(result) };
    } catch (error) {
      console.warn(`[connectors] composio sdk execute failed for ${input.actionSlug}; falling back to REST:`, error);
    }
  }
  const result = await composioRequest<Record<string, unknown>>({
    path: `/api/v3.1/tools/execute/${encodeURIComponent(input.actionSlug)}`,
    method: "POST",
    body: {
      ...(input.accountId ? { connected_account_id: input.accountId } : {}),
      user_id: getComposioEntityId(input.auth),
      arguments: input.payload,
    },
  });
  return { adapter: "composio-rest", result };
}

export async function executeApprovedComposioAction(input: {
  auth: AuthContext;
  toolkit: string;
  actionSlug: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<ConnectorActionResult> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const account = await getConnectedConnectorAccount({ auth: input.auth, toolkit });

  const existing = await pool.query<{
    status: "started" | "completed" | "failed" | "skipped";
    response_json: unknown;
  }>(
    `SELECT status, response_json
     FROM connector_action_events
     WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3
     LIMIT 1`,
    [input.auth.tenantId, input.auth.userId, input.idempotencyKey],
  );
  if (existing.rows[0]?.status === "completed") {
    return {
      ok: true,
      provider: "composio",
      toolkit,
      actionSlug: input.actionSlug,
      connectorAccountId: account.id,
      idempotencyKey: input.idempotencyKey,
      output: toObjectRecord(existing.rows[0].response_json),
      replayed: true,
    };
  }

  const eventId = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO connector_action_events
     (id, tenant_id, user_id, provider, connector_account_id, action_name, idempotency_key, status, request_json, response_json)
     VALUES ($1, $2, $3, 'composio', $4, $5, $6, 'started', $7::jsonb, '{}'::jsonb)
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
    [
      eventId,
      input.auth.tenantId,
      input.auth.userId,
      account.id,
      input.actionSlug,
      input.idempotencyKey,
      JSON.stringify({ toolkit, actionSlug: input.actionSlug, payload: input.payload }),
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    const replay = await pool.query<{ status: string; response_json: unknown }>(
      `SELECT status, response_json FROM connector_action_events
       WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3 LIMIT 1`,
      [input.auth.tenantId, input.auth.userId, input.idempotencyKey],
    );
    const row = replay.rows[0];
    if (row?.status === "completed") {
      return {
        ok: true,
        provider: "composio",
        toolkit,
        actionSlug: input.actionSlug,
        connectorAccountId: account.id,
        idempotencyKey: input.idempotencyKey,
        output: toObjectRecord(row.response_json),
        replayed: true,
      };
    }
    throw new Error(`Connector action is already ${row?.status ?? "in progress"}`);
  }

  try {
    const output = toolkit === "resend" && isNativeApiKeyConnector(account.metadata, account.externalAccountId)
      ? await executeNativeResendAction({
        auth: input.auth,
        actionSlug: input.actionSlug,
        payload: input.payload,
      })
      : await executeComposioActionDirect({
        auth: input.auth,
        toolkit,
        actionSlug: input.actionSlug,
        accountId: await resolveComposioConnectedAccountId({
          auth: input.auth,
          toolkit,
          accountId: account.externalAccountId,
          metadata: account.metadata,
        }),
        payload: input.payload,
      });
    await pool.query(
      `UPDATE connector_action_events
       SET status = 'completed', response_json = $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [eventId, JSON.stringify(output)],
    );
    return {
      ok: true,
      provider: "composio",
      toolkit,
      actionSlug: input.actionSlug,
      connectorAccountId: account.id,
      idempotencyKey: input.idempotencyKey,
      output,
    };
  } catch (error) {
    const output = { error: error instanceof Error ? error.message : String(error) };
    await pool.query(
      `UPDATE connector_action_events
       SET status = 'failed', response_json = $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [eventId, JSON.stringify(output)],
    );
    throw error;
  }
}

export async function runComposioToolkitPrompt(input: {
  auth: AuthContext;
  toolkit: string;
  prompt: string;
}): Promise<{ text: string; accountId: string; externalAccountId: string; toolkit: string }> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for Composio loop tools");
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;

  const accounts = await listConnectorAccounts(input.auth);
  const account = accounts.find((row) =>
    row.status === "connected" && row.appKey?.trim().toLowerCase() === toolkit
  );
  if (!account) throw new Error(`Connect ${toolkit} to use this loop tool`);

  const composio = getComposioVercelClient();
  const session = await composio.create(getComposioEntityId(input.auth), {
    connectedAccounts: { [toolkit]: account.externalAccountId },
  });
  const tools = await session.tools();
  const { text } = await generateText({
    model: anthropic(COMPOSIO_NATIVE_MODEL),
    tools,
    prompt: [
      "Use the connected app tools to answer the loop agent task.",
      "Prefer read/search/list operations. Do not create, update, delete, send, post, schedule, or mutate anything.",
      "If the requested work would require a write action, explain that it needs a future approval-gated action.",
      "",
      `Connected app: ${toolkit}`,
      `Task:\n${input.prompt}`,
    ].join("\n"),
    stopWhen: stepCountIs(8),
  });
  return {
    text: text.trim(),
    accountId: account.id,
    externalAccountId: account.externalAccountId,
    toolkit,
  };
}

function isResendApiKey(value: string): boolean {
  return /^re_[A-Za-z0-9_-]{16,}$/.test(value.trim());
}

async function verifyResendApiKey(apiKey: string): Promise<void> {
  const response = await fetch("https://api.resend.com/domains", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend key verification failed (${response.status})${body ? `: ${body}` : ""}`);
  }
}

export async function startConnectorAuth(input: {
  auth: AuthContext;
  provider: string;
  requiredScopes: string[];
  appKey?: string | null;
  redirectUri?: string | null;
}): Promise<{ sessionId: string; setupUrl: string; expiresAt: string }> {
  if (input.provider !== "composio") throw new Error("Composio is required for third-party workflow dependencies");
  return COMPOSIO_ADAPTER.startAuthSession({
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
    await pool.query(`UPDATE connector_auth_sessions SET status = 'expired', updated_at = NOW() WHERE id = $1`, [session.id]);
    return { status: "expired" };
  }
  const sessionMetadata = toObjectRecord(session.metadata_json);
  const sessionAppKey = typeof sessionMetadata.appKey === "string" ? sessionMetadata.appKey.trim().toLowerCase() : null;
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
      JSON.stringify({ source: "manual_continue", adapter: "composio", ...(sessionAppKey ? { appKey: sessionAppKey } : {}) }),
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
    requiredScopes: Array.isArray(row.required_scopes) ? row.required_scopes.filter((value): value is string => typeof value === "string") : [],
  };
}

export async function listConnectorAccounts(auth: AuthContext): Promise<ConnectorAccountView[]> {
  const result = await pool.query<{
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
  return result.rows.map((row) => {
    const scopes = Array.isArray(row.scopes_json) ? row.scopes_json.filter((v): v is string => typeof v === "string") : [];
    return {
      id: row.id,
      provider: row.provider,
      appKey: resolveConnectorAppKey({ provider: row.provider, scopes, metadata: row.metadata_json }),
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
  if (result.rowCount === 0) throw new Error("Connector account not found");
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
  return {
    provider: "resend",
    status: row ? "connected" : "missing",
    portalUrl: config.resendPortalUrl,
    apiKeysUrl: config.resendApiKeysUrl,
    docsUrl: config.resendDocsUrl,
    steps: [
      "Open your Resend dashboard and create an API key with full access.",
      "Copy the key now. Resend only shows it once.",
      "Paste the key here to connect your account securely. Tallei uses it to send broadcasts and configure analytics webhooks.",
    ],
    ...(row ? {
      connection: {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        last4: typeof metadata.last4 === "string" ? metadata.last4 : null,
        label: typeof metadata.label === "string" ? metadata.label : null,
      },
    } : {}),
  };
}

export async function upsertResendConnector(input: {
  auth: AuthContext;
  apiKey: string;
  label?: string | null;
}): Promise<ResendConnectorSetupView> {
  const trimmed = input.apiKey.trim();
  if (!isResendApiKey(trimmed)) throw new Error("Invalid Resend API key format");
  await verifyResendApiKey(trimmed);
  const last4 = trimmed.slice(-4);
  const label = (input.label ?? "").trim();
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
      `resend:${last4}`,
      JSON.stringify(["resend.send_email", "resend.webhooks.manage"]),
      JSON.stringify({
        appKey: "resend",
        authMode: "api_key",
        apiKeyCiphertext: encryptMemoryContent(trimmed),
        last4,
        ...(label ? { label } : {}),
      }),
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
    if ((result.rowCount ?? 0) === 0) throw new Error("Resend connector not found");
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
  if (!payload || typeof payload !== "object") return { ok: true, processed: false };
  const event = payload as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : event;
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  const talleiAuthSessionId = typeof data.talleiAuthSessionId === "string"
    ? data.talleiAuthSessionId
    : typeof metadata.talleiAuthSessionId === "string"
      ? metadata.talleiAuthSessionId
      : null;
  if (!talleiAuthSessionId) return { ok: true, processed: false };
  const accountId = typeof data.connectedAccountId === "string"
    ? data.connectedAccountId
    : typeof data.id === "string"
      ? data.id
      : `composio-${randomUUID()}`;
  const scopes = Array.isArray(data.scopes) ? data.scopes.filter((v): v is string => typeof v === "string") : [];
  const status = String(data.status ?? "").toLowerCase();
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
  if (!session) return { ok: true, processed: false };
  const sessionMetadata = toObjectRecord(session.metadata_json);
  const sessionAppKey = typeof sessionMetadata.appKey === "string" ? sessionMetadata.appKey.trim().toLowerCase() : null;
  await pool.query(
    `UPDATE connector_auth_sessions
     SET status = $2,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      talleiAuthSessionId,
      isRevoked ? "revoked" : isConnected ? "connected" : "auth_started",
      JSON.stringify({ composioWebhookEvent: eventType || "unknown", accountId }),
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

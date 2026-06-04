import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { generateText, stepCountIs } from "ai";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { encryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { pool } from "../../infrastructure/db/index.js";

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
  for (const path of ["/api/v3/toolkits", "/api/v3.1/toolkits"]) {
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
      console.warn(`[connectors] composio toolkit fallback failed for ${path}:`, error);
    }
  }
  return [];
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

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
  /** Server-only provider account ID. Never return this field from browser-facing routes. */
  externalAccountId: string;
  displayLabel: string | null;
  requiresLabel: boolean;
  status: ConnectorSetupState;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorAccountOption extends ConnectorAccountView {
  toolkit: string;
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
  outputSchema?: Record<string, unknown>;
  toolkitVersion?: string;
}

export interface ComposioToolSearchResult extends ComposioActionView {
  toolkitName: string;
  tags: string[];
}

export type ComposioTriggerTypeView = {
  toolkit: string;
  slug: string;
  name: string;
  description: string;
  type: "webhook" | "poll";
};

export interface ConnectorActionResult {
  ok: boolean;
  provider: "composio";
  toolkit: string;
  actionSlug: string;
  connectorAccountId: string;
  idempotencyKey: string;
  output: Record<string, unknown>;
  actionOutputData?: unknown;
  error?: string;
  providerLogId?: string;
  rawResponse?: Record<string, unknown>;
  replayed?: boolean;
}

export function normalizeComposioExecutionResult(raw: Record<string, unknown>): {
  ok: boolean;
  error?: string;
  providerLogId?: string;
  data?: unknown;
} {
  const envelope = toObjectRecord(raw.result);
  const nested = toObjectRecord(envelope.result);
  const candidates = [raw, envelope, nested];
  const successful = candidates.find((row) => typeof row.successful === "boolean")?.successful;
  const rawError = candidates
    .map((row) => row.error)
    .find((value) => value !== undefined && value !== null && value !== "" && value !== false);
  const error = typeof rawError === "string"
    ? rawError
    : rawError === undefined
      ? undefined
      : JSON.stringify(rawError);
  const providerLogId = candidates
    .map((row) => row.logId ?? row.log_id)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    ok: successful !== false && !error,
    ...(error ? { error } : {}),
    ...(providerLogId ? { providerLogId } : {}),
    ...("data" in nested ? { data: nested.data } : "data" in envelope ? { data: envelope.data } : {}),
  };
}

class ComposioActionExecutionError extends Error {
  constructor(message: string, readonly rawResponse: Record<string, unknown>, readonly providerLogId?: string) {
    super(message);
    this.name = "ComposioActionExecutionError";
  }
}

function getComposioEntityId(auth: AuthContext): string {
  return `${config.composioEntityPrefix}:${auth.tenantId}:${auth.userId}`;
}

export function inferComposioAppKey(scopes: string[]): string | null {
  const first = scopes.find((scope) => scope.trim().length > 0)?.trim().toLowerCase();
  if (!first) return null;
  if (first.startsWith("https://www.googleapis.com/auth/")) {
    const service = first.replace("https://www.googleapis.com/auth/", "").split(".")[0];
    if (service === "gmail" || service === "mail") return "gmail";
    if (service === "calendar") return "googlecalendar";
    if (service === "drive") return "google";
    if (service === "docs") return "googledocs";
    if (service === "sheets" || service === "slides") return "google";
    return service || null;
  }
  if (first.includes("google.com") || first.includes("googleapis.com")) {
    if (first.includes("mail")) return "gmail";
    if (first.includes("calendar")) return "googlecalendar";
    if (first.includes("docs")) return "googledocs";
    if (first.includes("drive")) return "google";
    return "google";
  }
  return first.split(/[.:/]/)[0] || null;
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
  if (!key) return "";
  if (key === "google_calendar") return "googlecalendar";
  if (key === "google-mail" || key === "googlemail") return "gmail";
  if (key === "resend_email") return "resend";
  return key;
}

export function filterComposioToolkitActions(actions: ComposioActionView[]): ComposioActionView[] {
  return actions;
}

const COMPOSIO_NATIVE_MODEL = process.env.TALLEI_CONNECTORS__COMPOSIO_NATIVE_MODEL || "claude-3-5-sonnet-latest";
let composioVercelClient: Composio<VercelProvider> | null = null;
const composioToolExecutionMetadataCache = new Map<string, {
  version: string;
  hasFileUploadableInput: boolean;
}>();

export function getComposioVercelClient(): Composio<VercelProvider> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  if (!composioVercelClient) {
    composioVercelClient = new Composio({
      apiKey: config.composioApiKey,
      provider: new VercelProvider(),
    });
  }
  return composioVercelClient;
}

type ComposioRawToolsClient = {
  list?: (filters: Record<string, unknown>) => Promise<unknown>;
  retrieve?: (slug: string, params?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * The Composio SDK's high-level helpers (`tools.list`, `getRawComposioTools`,
 * `getRawComposioToolBySlug`) run every tool through `ToolSchema.parse`
 * (`transformToolCases`). That schema requires `output_parameters` to be a
 * `{ type: "object", properties: {...} }` JSON schema, but the API returns
 * `output_parameters: {}` for many tools, so a single tool throws a ZodError and
 * the entire batch fails (ComposioHQ/composio#3354). We therefore read from the
 * SDK's underlying raw HTTP client, which returns the unparsed API response, and
 * normalize it ourselves with the schema-tolerant `normalizeComposioAction`.
 */
function getComposioRawToolsClient(): ComposioRawToolsClient | null {
  const composio = getComposioVercelClient() as unknown as {
    client?: { tools?: ComposioRawToolsClient };
  };
  return composio.client?.tools ?? null;
}

function schemaHasFileUploadableInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasFileUploadableInput);
  const row = value as Record<string, unknown>;
  if (row.file_uploadable === true) return true;
  return Object.values(row).some(schemaHasFileUploadableInput);
}

async function resolveComposioToolExecutionMetadata(actionSlug: string): Promise<{
  version: string;
  hasFileUploadableInput: boolean;
}> {
  const cacheKey = actionSlug.trim().toUpperCase();
  const cached = composioToolExecutionMetadataCache.get(cacheKey);
  if (cached) return cached;
  const rawTools = getComposioRawToolsClient();
  if (!rawTools?.retrieve) {
    throw new Error(`Composio SDK cannot resolve a toolkit version for ${actionSlug}`);
  }
  const tool = toObjectRecord(await rawTools.retrieve(actionSlug, { toolkit_versions: "latest" }));
  const version = String(tool.version ?? "").trim();
  if (!version || version.toLowerCase() === "latest") {
    throw new Error(`Composio returned no concrete toolkit version for ${actionSlug}`);
  }
  const metadata = {
    version,
    hasFileUploadableInput: schemaHasFileUploadableInput(tool.inputParameters ?? tool.input_parameters),
  };
  composioToolExecutionMetadataCache.set(cacheKey, metadata);
  return metadata;
}

export async function resolveComposioToolVersion(actionSlug: string): Promise<string> {
  return (await resolveComposioToolExecutionMetadata(actionSlug)).version;
}

async function createComposioToolkitAuthorizeLink(input: {
  auth: AuthContext;
  toolkitSlug: string;
  preferredAuthConfigId?: string | null;
  redirectUri?: string | null;
}): Promise<{ id: string | null; redirectUrl: string | null }> {
  const composio = getComposioVercelClient();
  const authConfigs = await composio.authConfigs.list({ toolkit: input.toolkitSlug });
  const enabledAuthConfigs = authConfigs.items.filter((authConfig) => authConfig.status === "ENABLED");
  let authConfigId = enabledAuthConfigs.find((authConfig) => authConfig.id === input.preferredAuthConfigId)?.id
    ?? enabledAuthConfigs[0]?.id;
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
  if (row.isDeprecated === true || row.is_deprecated === true) return null;
  const slug = String(row.slug ?? row.name ?? row.id ?? row.action ?? "").trim();
  if (!slug) return null;
  const name = String(row.displayName ?? row.name ?? slug).trim();
  const meta = toObjectRecord(row.meta);
  const description = String(row.description ?? meta.description ?? "").trim();
  const inputSchema = toObjectRecord(row.inputSchema ?? row.inputParameters ?? row.input_parameters ?? row.parameters ?? row.schema ?? row.argsSchema);
  const outputSchema = toObjectRecord(row.outputSchema ?? row.outputParameters ?? row.output_parameters ?? row.responseSchema ?? row.resultSchema);
  const toolkitVersion = String(row.version ?? row.toolkitVersion ?? row.toolkit_version ?? "").trim();
  return {
    toolkit,
    actionSlug: slug,
    name,
    description,
    risk: ["read", "write", "send", "destructive"].includes(String(row.risk ?? "").toLowerCase())
      ? String(row.risk).toLowerCase() as ConnectorActionRisk
      : "write",
    inputSchema,
    ...(Object.keys(outputSchema).length > 0 ? { outputSchema } : {}),
    ...(toolkitVersion && toolkitVersion.toLowerCase() !== "latest" ? { toolkitVersion } : {}),
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
    const rawTools = getComposioRawToolsClient();
    if (rawTools?.list) {
      const response = await rawTools.list({
        toolkit_slug: toolkit,
        limit: 50,
        toolkit_versions: "latest",
      });
      const items = filterComposioToolkitActions(normalizeItems(normalizeComposioToolSearchResponse(response)));
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
      const items = filterComposioToolkitActions(normalizeItems(data.items ?? data.tools));
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

export function normalizeComposioToolSearchResponse(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const row = toObjectRecord(response);
  for (const candidate of [row.items, row.tools, row.data, toObjectRecord(row.data).items]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseComposioSearchItems(items: unknown[], cappedLimit: number): ComposioToolSearchResult[] {
  const results: ComposioToolSearchResult[] = [];
  for (const item of items) {
    const row = toObjectRecord(item);
    if (row.isDeprecated === true || row.is_deprecated === true) continue;
    const toolkitRow = toObjectRecord(row.toolkit);
    const rawToolkit = String(toolkitRow.slug ?? row.toolkitSlug ?? row.toolkit_slug ?? "").trim();
    if (!rawToolkit) continue;
    const toolkit = normalizeComposioAppKey(rawToolkit);
    const action = normalizeComposioAction(toolkit, row);
    if (!action || !toolkit) continue;
    results.push({
      ...action,
      toolkitName: String(toolkitRow.name ?? toolkit),
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
  }
  return [...new Map(results.map((result) => [
    `${result.toolkit}:${result.actionSlug}`.toLowerCase(),
    result,
  ])).values()].slice(0, cappedLimit);
}

async function searchComposioToolsViaHttp(query: string, limit: number): Promise<ComposioToolSearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const paths = [
    `/api/v3.1/tools?query=${encodedQuery}&limit=${limit}&include_deprecated=false`,
    `/api/v3/tools?query=${encodedQuery}&limit=${limit}&include_deprecated=false`,
  ];
  for (const path of paths) {
    try {
      const data = await composioRequest<{ items?: unknown[]; tools?: unknown[] }>({ path });
      const items = normalizeComposioToolSearchResponse(data);
      const results = parseComposioSearchItems(items, limit);
      if (results.length > 0) return results;
    } catch (error) {
      console.warn(`[connectors] composio tool search http failed for ${path}:`, error);
    }
  }
  return [];
}

async function searchComposioToolsViaSdk(query: string, limit: number): Promise<ComposioToolSearchResult[]> {
  const rawTools = getComposioRawToolsClient();
  if (!rawTools?.list) return [];
  const response = await rawTools.list({
    search: query,
    limit,
    toolkit_versions: "latest",
  });
  if (!response) return [];
  return parseComposioSearchItems(normalizeComposioToolSearchResponse(response), limit);
}

export async function searchComposioTools(query: string, limit = 12): Promise<ComposioToolSearchResult[]> {
  if (!isComposioConfigured()) return [];
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return [];
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  try {
    const sdkResults = await searchComposioToolsViaSdk(normalizedQuery, cappedLimit);
    if (sdkResults.length > 0) return sdkResults;
  } catch (error) {
    console.warn("[connectors] composio tool search sdk failed:", error);
  }
  return searchComposioToolsViaHttp(normalizedQuery, cappedLimit);
}

/** Toolkit slugs from Connected Apps (`connector_accounts`), not notification Channels. */
export function connectedAppToolkits(accounts: ConnectorAccountView[]): string[] {
  return [...new Set(accounts
    .filter((account) => account.status === "connected")
    .map((account) => {
      const key = (account.appKey ?? (account.provider === "composio" ? "" : account.provider) ?? "").trim().toLowerCase();
      return key ? normalizeComposioAppKey(key) : "";
    })
    .filter(Boolean))];
}

export async function listConnectedAppToolkits(auth: AuthContext): Promise<string[]> {
  const accounts = await listConnectorAccounts(auth).catch(() => []);
  return connectedAppToolkits(accounts);
}

async function startComposioAuthSession(input: {
  auth: AuthContext;
  providerKey: string;
  appKey: string;
  redirectUri?: string | null;
  requiredScopes: string[];
  workflowBuilderSessionId?: string | null;
  buildRequirementId?: string | null;
}): Promise<{ sessionId: string; setupUrl: string; expiresAt: string }> {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const appKey = normalizeComposioAppKey(input.appKey);
    if (!appKey) throw new Error("Connector toolkit is required to start Composio auth");
    let setupUrl: string | null = null;
    let externalSessionId: string | null = null;
    let existingConnectedAccountIds: string[] = [];
    if (isComposioConfigured()) {
      try {
        const composio = getComposioVercelClient();
        const existing = await composio.connectedAccounts.list({
          userIds: [getComposioEntityId(input.auth)],
          toolkitSlugs: [appKey],
        });
        existingConnectedAccountIds = (Array.isArray(existing.items) ? existing.items : [])
          .filter((account) => ["active", "connected", "enabled"].includes(String(account.status ?? "").toLowerCase()))
          .flatMap((account) => typeof account.id === "string" ? [account.id] : []);
        const request = await createComposioToolkitAuthorizeLink({
          auth: input.auth,
          toolkitSlug: appKey,
          preferredAuthConfigId: config.composioAuthConfigId,
          redirectUri: input.redirectUri ?? null,
        });
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
       (id, tenant_id, user_id, provider, status, setup_url, required_scopes, expires_at, metadata_json,
        workflow_builder_session_id, build_requirement_id, toolkit_identity)
       VALUES ($1, $2, $3, $4, 'auth_started', $5, $6::jsonb, $7::timestamptz, $8::jsonb, $9::uuid, $10, $11)`,
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
          composio: { externalSessionId, configured: isComposioConfigured(), existingConnectedAccountIds },
        }),
        input.workflowBuilderSessionId ?? null,
        input.buildRequirementId ?? null,
        appKey,
      ]
    );
    return { sessionId, setupUrl, expiresAt };
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
  connectorAccountId?: string;
}): Promise<ConnectedConnectorAccount> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  const result = await pool.query<{
    id: string;
    provider: string;
    external_account_id: string;
    display_label: string | null;
    status: ConnectorSetupState;
    scopes_json: unknown;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, provider, external_account_id, display_label, status, scopes_json, metadata_json, created_at, updated_at
     FROM connector_accounts
     WHERE tenant_id = $1
       AND user_id = $2
       AND status = 'connected'
       AND ($3::uuid IS NULL OR id = $3::uuid)
     ORDER BY updated_at DESC`,
    [input.auth.tenantId, input.auth.userId, input.connectorAccountId ?? null],
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
      displayLabel: row.display_label,
      requiresLabel: !row.display_label?.trim(),
      status: row.status,
      scopes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: toObjectRecord(row.metadata_json),
      externalAccountId: row.external_account_id,
    };
  }
  throw new Error(`Connect ${toolkit} before executing connector actions`);
}

export async function reconcileComposioConnectorAccounts(input: {
  auth: AuthContext;
  toolkits?: string[];
}): Promise<ConnectorAccountOption[]> {
  if (!isComposioConfigured()) {
    return (await listConnectorAccounts(input.auth))
      .filter((account) => account.appKey)
      .map((account) => ({ ...account, toolkit: account.appKey! }));
  }
  const toolkits = [...new Set((input.toolkits ?? []).map(normalizeComposioAppKey).filter(Boolean))];
  const composio = getComposioVercelClient();
  const response = await composio.connectedAccounts.list({
    userIds: [getComposioEntityId(input.auth)],
    ...(toolkits.length > 0 ? { toolkitSlugs: toolkits } : {}),
    limit: 100,
  });
  const providerAccounts = Array.isArray(response.items) ? response.items : [];
  const providerAccountIds = providerAccounts.flatMap((account) =>
    typeof account.id === "string" && account.id.trim() ? [account.id.trim()] : []);
  if (toolkits.length > 0) {
    await pool.query(
      `UPDATE connector_accounts
       SET status = 'revoked', updated_at = NOW()
       WHERE tenant_id = $1
         AND user_id = $2
         AND provider = 'composio'
         AND metadata_json->>'appKey' = ANY($3::text[])
         AND NOT (external_account_id = ANY($4::text[]))`,
      [input.auth.tenantId, input.auth.userId, toolkits, providerAccountIds],
    );
  }
  for (const raw of providerAccounts) {
    const row = raw as typeof raw & { toolkit?: { slug?: unknown } };
    const toolkit = normalizeComposioAppKey(String(row.toolkit?.slug ?? ""));
    const externalAccountId = typeof row.id === "string" ? row.id.trim() : "";
    if (!toolkit || !externalAccountId) continue;
    const statusText = String(row.status ?? "").toLowerCase();
    const status: ConnectorSetupState = ["active", "connected", "enabled"].includes(statusText)
      ? "connected"
      : statusText === "expired"
        ? "expired"
        : statusText === "revoked" || statusText === "inactive"
          ? "revoked"
          : statusText === "failed"
            ? "failed"
            : "auth_started";
    const providerLabel = typeof row.alias === "string" && row.alias.trim() ? row.alias.trim() : null;
    await pool.query(
      `INSERT INTO connector_accounts
       (id, tenant_id, user_id, provider, external_account_id, display_label, status, scopes_json, metadata_json)
       VALUES ($1, $2, $3, 'composio', $4, $5, $6, '[]'::jsonb, $7::jsonb)
       ON CONFLICT (tenant_id, user_id, provider, external_account_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         display_label = COALESCE(connector_accounts.display_label, EXCLUDED.display_label),
         metadata_json = COALESCE(connector_accounts.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
         updated_at = NOW()`,
      [
        randomUUID(),
        input.auth.tenantId,
        input.auth.userId,
        externalAccountId,
        providerLabel,
        status,
        JSON.stringify({ adapter: "composio", appKey: toolkit, alias: row.alias ?? null, wordId: row.wordId ?? null }),
      ],
    );
  }
  return (await listConnectorAccounts(input.auth))
    .filter((account) => account.appKey && (toolkits.length === 0 || toolkits.includes(account.appKey)))
    .map((account) => ({ ...account, toolkit: account.appKey! }));
}

export async function renameConnectorAccount(input: {
  auth: AuthContext;
  accountId: string;
  displayLabel: string;
}): Promise<ConnectorAccountView> {
  const result = await pool.query(
    `UPDATE connector_accounts
     SET display_label = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING id`,
    [input.accountId, input.auth.tenantId, input.auth.userId, input.displayLabel.trim()],
  );
  if (!result.rows[0]) throw new Error("Connector account not found");
  const account = (await listConnectorAccounts(input.auth)).find((entry) => entry.id === input.accountId);
  if (!account) throw new Error("Connector account not found");
  return account;
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

export async function resolveConnectedComposioAccountIds(input: {
  auth: AuthContext;
  toolkits: string[];
}): Promise<Record<string, string>> {
  if (!isComposioConfigured()) return {};
  const toolkits = [...new Set(input.toolkits.map(normalizeComposioAppKey).filter(Boolean))];
  if (toolkits.length === 0) return {};
  const composio = getComposioVercelClient();
  const accounts = await composio.connectedAccounts.list({
    userIds: [getComposioEntityId(input.auth)],
    toolkitSlugs: toolkits,
  });
  const resolved: Record<string, string> = {};
  for (const account of Array.isArray(accounts.items) ? accounts.items : []) {
    if (!["active", "connected", "enabled"].includes(String(account.status ?? "").toLowerCase())) continue;
    const id = typeof account.id === "string" ? account.id.trim() : "";
    const row = account as typeof account & { toolkit?: { slug?: unknown }; toolkitSlug?: unknown; toolkit_slug?: unknown };
    const toolkit = normalizeComposioAppKey(String(row.toolkit?.slug ?? row.toolkitSlug ?? row.toolkit_slug ?? ""));
    if (id && toolkit && toolkits.includes(toolkit) && !isPlaceholderConnectedAccountId(id)) resolved[toolkit] = id;
  }
  return resolved;
}

export async function listComposioTriggerTypes(toolkits: string[]): Promise<ComposioTriggerTypeView[]> {
  if (!isComposioConfigured()) return [];
  const normalized = [...new Set(toolkits.map(normalizeComposioAppKey).filter(Boolean))];
  if (normalized.length === 0) return [];
  const composio = getComposioVercelClient() as unknown as {
    client?: {
      triggersTypes?: {
        list?: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(await composio.client?.triggersTypes?.list?.({
    toolkit_slugs: normalized,
    toolkit_versions: "latest",
    limit: 1000,
  }));
  const items = Array.isArray(response.items) ? response.items : [];
  return items.flatMap((item) => {
    const row = toObjectRecord(item);
    const toolkit = normalizeComposioAppKey(String(toObjectRecord(row.toolkit).slug ?? ""));
    const slug = String(row.slug ?? "").trim();
    const configSchema = toObjectRecord(row.config);
    const required = Array.isArray(configSchema.required) ? configSchema.required : [];
    const type = row.type === "webhook" ? "webhook" : row.type === "poll" ? "poll" : null;
    if (!toolkit || !slug || !type || required.length > 0) return [];
    return [{
      toolkit,
      slug,
      name: String(row.name ?? slug),
      description: String(row.description ?? "Run when this event occurs."),
      type,
    }];
  });
}

export async function registerComposioTrigger(input: {
  auth: AuthContext;
  toolkit: string;
  triggerSlug: string;
}): Promise<{ triggerId: string; connectedAccountId: string }> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  const connectedAccountId = (await resolveConnectedComposioAccountIds({ auth: input.auth, toolkits: [toolkit] }))[toolkit];
  if (!connectedAccountId) throw new Error(`Connect ${toolkit} before enabling its event trigger.`);
  const composio = getComposioVercelClient() as unknown as {
    client?: {
      triggerInstances?: {
        upsert?: (slug: string, input: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(await composio.client?.triggerInstances?.upsert?.(input.triggerSlug, {
    connected_account_id: connectedAccountId,
    toolkit_versions: "latest",
    trigger_config: {},
  }));
  const triggerId = String(response.trigger_id ?? toObjectRecord(response.deprecated).uuid ?? "").trim();
  if (!triggerId) throw new Error("Composio did not return a trigger ID.");
  return { triggerId, connectedAccountId };
}

async function executeComposioActionDirect(input: {
  auth: AuthContext;
  toolkit: string;
  actionSlug: string;
  accountId?: string;
  payload: Record<string, unknown>;
  toolkitVersion?: string;
}): Promise<Record<string, unknown>> {
  const composio = getComposioVercelClient() as unknown as {
    tools?: {
      execute?: (slug: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  const metadata = await resolveComposioToolExecutionMetadata(input.actionSlug);
  const version = input.toolkitVersion ?? metadata.version;
  const executeArgs = {
    userId: getComposioEntityId(input.auth),
    arguments: input.payload,
    version,
    ...(input.accountId ? { connectedAccountId: input.accountId } : {}),
  };
  if (!composio.tools?.execute) throw new Error("Composio SDK execute API is unavailable.");
  const result = await composio.tools.execute(input.actionSlug, executeArgs);
  return { adapter: "composio-sdk", result: toObjectRecord(result) };
}

export async function executeApprovedComposioAction(input: {
  auth: AuthContext;
  toolkit: string;
  actionSlug: string;
  connectorAccountId?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  toolkitVersion?: string;
}): Promise<ConnectorActionResult> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const account = await getConnectedConnectorAccount({
    auth: input.auth,
    toolkit,
    connectorAccountId: input.connectorAccountId,
  });

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
    const rawResponse = toObjectRecord(existing.rows[0].response_json);
    const normalized = normalizeComposioExecutionResult(rawResponse);
    if (!normalized.ok) {
      return {
        ok: false, provider: "composio", toolkit, actionSlug: input.actionSlug,
        connectorAccountId: account.id, idempotencyKey: input.idempotencyKey,
        output: rawResponse, rawResponse, error: normalized.error ?? `Composio action ${input.actionSlug} reported failure`,
        ...(normalized.providerLogId ? { providerLogId: normalized.providerLogId } : {}), replayed: true,
      };
    }
    return {
      ok: true,
      provider: "composio",
      toolkit,
      actionSlug: input.actionSlug,
      connectorAccountId: account.id,
      idempotencyKey: input.idempotencyKey,
      output: rawResponse,
      rawResponse,
      ...("data" in normalized ? { actionOutputData: normalized.data } : {}),
      ...(normalized.providerLogId ? { providerLogId: normalized.providerLogId } : {}),
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
      JSON.stringify({
        toolkit,
        actionSlug: input.actionSlug,
        payload: input.payload,
        ...(input.toolkitVersion ? { toolkitVersion: input.toolkitVersion } : {}),
      }),
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
      const rawResponse = toObjectRecord(row.response_json);
      const normalized = normalizeComposioExecutionResult(rawResponse);
      if (!normalized.ok) {
        return {
          ok: false, provider: "composio", toolkit, actionSlug: input.actionSlug,
          connectorAccountId: account.id, idempotencyKey: input.idempotencyKey,
          output: rawResponse, rawResponse, error: normalized.error ?? `Composio action ${input.actionSlug} reported failure`,
          ...(normalized.providerLogId ? { providerLogId: normalized.providerLogId } : {}), replayed: true,
        };
      }
      return {
        ok: true,
        provider: "composio",
        toolkit,
        actionSlug: input.actionSlug,
        connectorAccountId: account.id,
        idempotencyKey: input.idempotencyKey,
        output: rawResponse,
        rawResponse,
        ...("data" in normalized ? { actionOutputData: normalized.data } : {}),
        ...(normalized.providerLogId ? { providerLogId: normalized.providerLogId } : {}),
        replayed: true,
      };
    }
    throw new Error(`Connector action is already ${row?.status ?? "in progress"}`);
  }

  try {
    const output = await executeComposioActionDirect({
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
        toolkitVersion: input.toolkitVersion,
      });
    const normalized = normalizeComposioExecutionResult(output);
    if (!normalized.ok) {
      throw new ComposioActionExecutionError(
        normalized.error ?? `Composio action ${input.actionSlug} reported failure`,
        output,
        normalized.providerLogId,
      );
    }
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
      rawResponse: output,
      ...("data" in normalized ? { actionOutputData: normalized.data } : {}),
      ...(normalized.providerLogId ? { providerLogId: normalized.providerLogId } : {}),
    };
  } catch (error) {
    const output = error instanceof ComposioActionExecutionError
      ? { error: error.message, rawResponse: error.rawResponse, providerLogId: error.providerLogId }
      : { error: error instanceof Error ? error.message : String(error) };
    await pool.query(
      `UPDATE connector_action_events
       SET status = 'failed', response_json = $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [eventId, JSON.stringify(output)],
    );
    if (error instanceof ComposioActionExecutionError) {
      return {
        ok: false,
        provider: "composio",
        toolkit,
        actionSlug: input.actionSlug,
        connectorAccountId: account.id,
        idempotencyKey: input.idempotencyKey,
        output: error.rawResponse,
        rawResponse: error.rawResponse,
        error: error.message,
        ...(error.providerLogId ? { providerLogId: error.providerLogId } : {}),
      };
    }
    throw error;
  }
}

export async function markConnectorActionEventFailed(input: {
  auth: AuthContext;
  idempotencyKey: string;
  error: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `UPDATE connector_action_events
     SET status = 'failed', response_json = $4::jsonb, updated_at = NOW()
     WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [
      input.auth.tenantId,
      input.auth.userId,
      input.idempotencyKey,
      JSON.stringify({ error: input.error, ...(input.details ?? {}) }),
    ],
  );
}

export async function runComposioToolkitPrompt(input: {
  auth: AuthContext;
  toolkit: string;
  prompt: string;
  connectorAccountId?: string;
}): Promise<{ text: string; accountId: string; externalAccountId: string; toolkit: string }> {
  const toolkit = normalizeComposioAppKey(input.toolkit);
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for Composio loop tools");
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;

  const account = await getConnectedConnectorAccount({
    auth: input.auth,
    toolkit,
    connectorAccountId: input.connectorAccountId,
  });

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
  workflowBuilderSessionId?: string | null;
  buildRequirementId?: string | null;
}): Promise<{ sessionId: string; setupUrl: string; expiresAt: string }> {
  if (input.provider !== "composio") throw new Error("Composio is required for third-party workflow dependencies");
  const appKey = normalizeComposioAppKey(input.appKey ?? inferComposioAppKey(input.requiredScopes));
  if (!appKey) throw new Error("Connector toolkit is required to start Composio auth");
  return startComposioAuthSession({
    auth: input.auth,
    providerKey: input.provider,
    appKey,
    redirectUri: input.redirectUri,
    requiredScopes: input.requiredScopes,
    workflowBuilderSessionId: input.workflowBuilderSessionId,
    buildRequirementId: input.buildRequirementId,
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
  const composioSessionMetadata = toObjectRecord(sessionMetadata.composio);
  const existingConnectedAccountIds = new Set(Array.isArray(composioSessionMetadata.existingConnectedAccountIds)
    ? composioSessionMetadata.existingConnectedAccountIds.filter((value): value is string => typeof value === "string")
    : []);
  let verifiedExternalAccountId = input.externalAccountId?.trim() || "";
  if (session.provider === "composio" && sessionAppKey && !verifiedExternalAccountId) {
    const composio = getComposioVercelClient();
    const accounts = await composio.connectedAccounts.list({
      userIds: [getComposioEntityId(input.auth)],
      toolkitSlugs: [normalizeComposioAppKey(sessionAppKey)],
    });
    const active = (Array.isArray(accounts.items) ? accounts.items : []).find((item) =>
      ["active", "connected", "enabled"].includes(String(item.status ?? "").toLowerCase())
      && !existingConnectedAccountIds.has(String(item.id ?? "")),
    );
    verifiedExternalAccountId = typeof active?.id === "string" ? active.id.trim() : "";
    if (!verifiedExternalAccountId) {
      await pool.query(
        `UPDATE connector_auth_sessions SET status = 'auth_started', updated_at = NOW() WHERE id = $1`,
        [session.id],
      );
      return { status: "auth_started" };
    }
  }
  if (session.provider === "composio" && !verifiedExternalAccountId) {
    await pool.query(
      `UPDATE connector_auth_sessions SET status = 'auth_started', updated_at = NOW() WHERE id = $1`,
      [session.id],
    );
    return { status: "auth_started" };
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
      verifiedExternalAccountId,
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
  workflowBuilderSessionId?: string;
  buildRequirementId?: string;
  toolkit?: string;
}> {
  const result = await pool.query<{
    id: string;
    provider: string;
    status: ConnectorSetupState;
    setup_url: string;
    expires_at: string;
    required_scopes: unknown;
    workflow_builder_session_id: string | null;
    build_requirement_id: string | null;
    toolkit_identity: string | null;
  }>(
    `SELECT id, provider, status, setup_url, expires_at, required_scopes,
            workflow_builder_session_id, build_requirement_id, toolkit_identity
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
    ...(row.workflow_builder_session_id ? { workflowBuilderSessionId: row.workflow_builder_session_id } : {}),
    ...(row.build_requirement_id ? { buildRequirementId: row.build_requirement_id } : {}),
    ...(row.toolkit_identity ? { toolkit: row.toolkit_identity } : {}),
  };
}

export async function listConnectorAccounts(auth: AuthContext): Promise<ConnectorAccountView[]> {
  const result = await pool.query<{
    id: string;
    provider: string;
    external_account_id: string;
    display_label: string | null;
    status: ConnectorSetupState;
    scopes_json: unknown;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, provider, external_account_id, display_label, status, scopes_json, metadata_json, created_at, updated_at
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
      displayLabel: row.display_label,
      requiresLabel: !row.display_label?.trim(),
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

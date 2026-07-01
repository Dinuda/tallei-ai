import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { normalizeToolkitSlug } from "./auth.js";

let composioClient: Composio<VercelProvider> | null = null;
const toolkitVersionOverrides: Record<string, string> = {};
const COMPOSIO_REQUEST_TIMEOUT_MS = 10_000;

function readComposioToolkitVersionsFromEnv(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("COMPOSIO_TOOLKIT_VERSION_") || !value?.trim()) continue;
    const slug = normalizeToolkitSlug(key.slice("COMPOSIO_TOOLKIT_VERSION_".length));
    if (!slug) continue;
    versions[slug] = value.trim();
  }
  return versions;
}

function buildToolkitVersions(): Record<string, string> {
  return {
    ...readComposioToolkitVersionsFromEnv(),
    ...toolkitVersionOverrides,
  };
}

export function rememberToolkitVersion(toolkit: string, version: string): void {
  const slug = normalizeToolkitSlug(toolkit);
  const normalizedVersion = version.trim();
  if (!slug || !normalizedVersion || normalizedVersion.toLowerCase() === "latest") return;
  if (toolkitVersionOverrides[slug] === normalizedVersion) return;
  toolkitVersionOverrides[slug] = normalizedVersion;
  composioClient = null;
}

export function getComposioToolkitVersion(toolkit: string): string {
  const slug = normalizeToolkitSlug(toolkit);
  return slug ? buildToolkitVersions()[slug] ?? "latest" : "latest";
}

export function getComposioEntityId(auth: AuthContext): string {
  const base = `${config.composioEntityPrefix}:${auth.tenantId}:${auth.userId}`;
  if (!auth.workspaceId) return base;
  return `${base}:${auth.workspaceId}`;
}

export function isComposioConfigured(): boolean {
  return Boolean(config.composioApiKey && config.composioBaseUrl);
}

export function getComposioClient(): Composio<VercelProvider> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  if (!composioClient) {
    const toolkitVersions = buildToolkitVersions();
    composioClient = new Composio({
      apiKey: config.composioApiKey,
      baseURL: config.composioBaseUrl,
      provider: new VercelProvider(),
      ...(Object.keys(toolkitVersions).length > 0 ? { toolkitVersions } : {}),
    });
  }
  return composioClient;
}

export type ComposioRawToolsClient = {
  list?: (filters: Record<string, unknown>) => Promise<unknown>;
  retrieve?: (slug: string, params?: Record<string, unknown>) => Promise<unknown>;
};

export function getComposioRawToolsClient(): ComposioRawToolsClient | null {
  const composio = getComposioClient() as unknown as {
    client?: { tools?: ComposioRawToolsClient };
  };
  return composio.client?.tools ?? null;
}

export async function withComposioTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = COMPOSIO_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function composioRequest<T>(input: {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<T> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPOSIO_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.composioBaseUrl}${input.path}`, {
      method: input.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.composioApiKey,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Composio request timed out after ${COMPOSIO_REQUEST_TIMEOUT_MS}ms: ${input.path}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) {
      throw new Error(`Composio request failed (${response.status}): non-JSON response (${contentType})`);
    }
    return {} as T;
  }
  const data = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) throw new Error(`Composio request failed (${response.status}): ${JSON.stringify(data)}`);
  return data as T;
}

export function toObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";

let composioClient: Composio<VercelProvider> | null = null;

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
    composioClient = new Composio({
      apiKey: config.composioApiKey,
      baseURL: config.composioBaseUrl,
      provider: new VercelProvider(),
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

export async function composioRequest<T>(input: {
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

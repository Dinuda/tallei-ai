import { config } from "../../config/index.js";
import { composioRequest, isComposioConfigured, toObjectRecord } from "./client.js";

/** Secrets returned by Composio subscription API (in addition to env). */
const runtimeWebhookSecrets = new Set<string>();

export function rememberComposioWebhookSecret(secret: string): void {
  const trimmed = secret.trim();
  if (!trimmed) return;
  runtimeWebhookSecrets.add(trimmed);
}

export function composioWebhookSecretsToTry(): string[] {
  const secrets = new Set<string>();
  if (config.composioWebhookSecret.trim()) secrets.add(config.composioWebhookSecret.trim());
  for (const secret of runtimeWebhookSecrets) secrets.add(secret);
  return [...secrets];
}

/** Canonical public URL Composio should deliver to (matches app.ts route). */
export function composioWebhookDeliveryUrl(): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/connectors/composio/webhook`;
}

export function isLocalWebhookUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true;
  }
}

type WebhookSubscriptionRow = {
  webhook_url?: string;
  webhookUrl?: string;
  secret?: string;
  id?: string;
};

function readSubscriptionRow(row: unknown): { url: string | null; secret: string | null; id: string | null } {
  const record = toObjectRecord(row);
  const url = String(record.webhook_url ?? record.webhookUrl ?? "").trim() || null;
  const secret = String(record.secret ?? "").trim() || null;
  const id = String(record.id ?? "").trim() || null;
  return { url, secret, id };
}

/** Load signing secrets from Composio subscription list responses. */
export function ingestWebhookSubscriptionItems(items: unknown[]): number {
  let added = 0;
  for (const item of items) {
    const { secret, url } = readSubscriptionRow(item);
    if (!secret) continue;
    const before = runtimeWebhookSecrets.size;
    rememberComposioWebhookSecret(secret);
    if (runtimeWebhookSecrets.size > before) added += 1;
    if (url) {
      console.info("[integrations/composio] loaded webhook signing secret from subscription", { url });
    }
  }
  return added;
}

let lastSecretSyncMs = 0;
const SECRET_SYNC_COOLDOWN_MS = 60_000;

/**
 * Fetch webhook signing secrets from Composio (GET /webhook_subscriptions).
 * The subscription secret is what Composio uses to sign deliveries — it may differ from a dashboard copy.
 */
export async function syncComposioWebhookSecretsFromApi(options?: { force?: boolean }): Promise<{
  synced: boolean;
  secretCount: number;
  reason?: string;
}> {
  if (!isComposioConfigured()) {
    return { synced: false, secretCount: composioWebhookSecretsToTry().length, reason: "composio_not_configured" };
  }
  const now = Date.now();
  if (!options?.force && now - lastSecretSyncMs < SECRET_SYNC_COOLDOWN_MS) {
    return { synced: false, secretCount: composioWebhookSecretsToTry().length, reason: "cooldown" };
  }
  try {
    const listed = await composioRequest<{ items?: unknown[]; data?: unknown[] }>({
      path: "/api/v3.1/webhook_subscriptions",
    });
    const items = Array.isArray(listed.items) ? listed.items : Array.isArray(listed.data) ? listed.data : [];
    ingestWebhookSubscriptionItems(items);
    lastSecretSyncMs = now;
    return { synced: true, secretCount: composioWebhookSecretsToTry().length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[integrations/composio] failed to sync webhook secrets:", message);
    return { synced: false, secretCount: composioWebhookSecretsToTry().length, reason: "sync_failed" };
  }
}

/** Ensure at least one signing secret is available (env and/or Composio API). */
export async function ensureComposioWebhookSecretsHydrated(): Promise<void> {
  if (composioWebhookSecretsToTry().length > 0) {
    await syncComposioWebhookSecretsFromApi();
    return;
  }
  await syncComposioWebhookSecretsFromApi({ force: true });
}

/**
 * Register Tallei's webhook URL with Composio (once per project).
 * Composio will not deliver trigger events until this is set.
 */
export async function ensureComposioWebhookSubscription(): Promise<{
  webhookUrl: string;
  configured: boolean;
  reason?: string;
}> {
  const webhookUrl = composioWebhookDeliveryUrl();
  if (!isComposioConfigured()) {
    return { webhookUrl, configured: false, reason: "composio_not_configured" };
  }
  if (isLocalWebhookUrl(webhookUrl)) {
    return {
      webhookUrl,
      configured: false,
      reason: "local_webhook_url",
    };
  }

  try {
    const listed = await composioRequest<{ items?: unknown[]; data?: unknown[] }>({
      path: "/api/v3.1/webhook_subscriptions",
    });
    const items = Array.isArray(listed.items) ? listed.items : Array.isArray(listed.data) ? listed.data : [];
    ingestWebhookSubscriptionItems(items);
    const matching = items
      .map((row) => readSubscriptionRow(row))
      .find((row) => row.url === webhookUrl);
    if (matching) {
      return { webhookUrl, configured: true };
    }

    const stale = items.map((row) => readSubscriptionRow(row)).find((row) => row.id && row.url);
    if (stale?.id) {
      const updated = await composioRequest<Record<string, unknown>>({
        path: `/api/v3.1/webhook_subscriptions/${stale.id}`,
        method: "PATCH",
        body: {
          webhook_url: webhookUrl,
          enabled_events: ["composio.trigger.message", "composio.trigger.disabled", "composio.connected_account.expired"],
          version: "V3",
        },
      });
      const updatedSecret = String(updated.secret ?? toObjectRecord(updated.data).secret ?? "").trim();
      if (updatedSecret) rememberComposioWebhookSecret(updatedSecret);
      console.info("[integrations/composio] updated webhook subscription URL", {
        from: stale.url,
        to: webhookUrl,
      });
      return { webhookUrl, configured: true };
    }

    const created = await composioRequest<Record<string, unknown>>({
      path: "/api/v3.1/webhook_subscriptions",
      method: "POST",
      body: {
        webhook_url: webhookUrl,
        enabled_events: ["composio.trigger.message"],
        version: "V3",
      },
    });
    const createdSecret = String(
      created.secret
      ?? toObjectRecord(created.data).secret
      ?? "",
    ).trim();
    if (createdSecret) {
      rememberComposioWebhookSecret(createdSecret);
      console.info(
        "[integrations/composio] webhook subscription created — set TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET to the Composio project secret",
      );
    }
    return { webhookUrl, configured: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[integrations/composio] failed to ensure webhook subscription:", message);
    return { webhookUrl, configured: false, reason: "subscription_api_failed" };
  }
}

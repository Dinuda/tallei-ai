import type { AuthContext } from "../../domain/auth/index.js";
import { resolveToolkitSlug } from "./auth.js";
import { resolveConnectedAccountId } from "./accounts.js";
import { getComposioClient, isComposioConfigured, toObjectRecord } from "./client.js";
import {
  deactivateLoopTriggerSubscription,
  ensureWorkspaceTriggerChannel,
  getLoopTriggerSubscription,
  releaseWorkspaceTriggerChannel,
  upsertLoopTriggerSubscription,
  type LoopTriggerSubscriptionRow,
} from "./trigger-channels.js";
import { ensureComposioWebhookSubscription } from "./webhook-subscription.js";

export type ComposioTriggerTypeRow = {
  slug: string;
  name: string;
};

const MIN_TRIGGER_SCORE = 4;

export function scoreTriggerSlugMatch(
  eventType: string,
  slug: string,
  name: string,
): number {
  const tokens = eventType.toLowerCase().split(/[._\s-]+/).filter(Boolean);
  const hay = `${slug} ${name}`.toLowerCase();
  return tokens.reduce((score, token) => (hay.includes(token) ? score + 2 : score), 0);
}

export async function listComposioTriggerTypes(toolkit: string): Promise<ComposioTriggerTypeRow[]> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggersTypes?: {
        list?: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(
    await composio.client?.triggersTypes?.list?.({
      toolkit_slugs: [toolkit],
      toolkit_versions: "latest",
      limit: 50,
    }),
  );
  const items = Array.isArray(response.items) ? response.items : [];
  return items.flatMap((item) => {
    const row = toObjectRecord(item);
    const slug = String(row.slug ?? "").trim();
    if (!slug) return [];
    return [{ slug, name: String(row.name ?? slug).trim() }];
  });
}

function pickAvailableSlug(
  candidate: string | null | undefined,
  available: ComposioTriggerTypeRow[],
): string | null {
  if (!candidate) return null;
  const upper = candidate.toUpperCase();
  const match = available.find((row) => row.slug.toUpperCase() === upper);
  return match?.slug ?? null;
}

/** Catalogue helper for Conductor — prefers exact slug match. */
export async function resolveTriggerSlugWithCatalog(
  toolkit: string,
  eventTypeOrSlug: string,
): Promise<string> {
  const normalizedToolkit = await resolveToolkitSlug(toolkit);
  const available = await listComposioTriggerTypes(normalizedToolkit);

  const fromExactSlug = pickAvailableSlug(eventTypeOrSlug.trim(), available);
  if (fromExactSlug) return fromExactSlug;

  let best: { slug: string; score: number } | null = null;
  for (const row of available) {
    const score = scoreTriggerSlugMatch(eventTypeOrSlug, row.slug, row.name);
    if (!best || score > best.score) best = { slug: row.slug, score };
  }
  if (best && best.score >= MIN_TRIGGER_SCORE) return best.slug;

  throw new Error(
    `No Composio trigger for ${normalizedToolkit}/${eventTypeOrSlug}. ` +
      `Available: ${available.map((row) => row.slug).join(", ") || "none"}`,
  );
}

export async function validateComposioTriggerSlug(
  toolkit: string,
  composioSlug: string,
): Promise<string> {
  const normalizedToolkit = await resolveToolkitSlug(toolkit);
  const available = await listComposioTriggerTypes(normalizedToolkit);
  const match = pickAvailableSlug(composioSlug, available);
  if (!match) {
    throw new Error(
      `Trigger ${composioSlug} is not available for ${normalizedToolkit}. ` +
        `Available: ${available.map((row) => row.slug).join(", ") || "none"}`,
    );
  }
  return match.toUpperCase();
}

export type LoopTriggerRegistrationRow = LoopTriggerSubscriptionRow & {
  composio_trigger_slug?: string;
  composio_instance_id?: string | null;
  toolkit?: string;
  event_type?: string;
};

/** @deprecated Use getLoopTriggerSubscription */
export async function getLoopTriggerRegistration(loopId: string) {
  return getLoopTriggerSubscription(loopId);
}

export async function registerLoopEventTrigger(input: {
  auth: AuthContext;
  loopId: string;
  workspaceId: string;
  source: string;
  composioSlug: string;
}): Promise<LoopTriggerSubscriptionRow> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const toolkit = await resolveToolkitSlug(input.source);
  const composioTriggerSlug = await validateComposioTriggerSlug(toolkit, input.composioSlug);
  const connectedAccountId = await resolveConnectedAccountId(input.auth, toolkit);
  if (!connectedAccountId) {
    throw new Error(`Connect ${toolkit} before enabling its event trigger`);
  }

  const existing = await getLoopTriggerSubscription(input.loopId);
  if (existing?.status === "active" && existing.channel_id) {
    await deactivateLoopTriggerSubscription(input.loopId);
    await releaseWorkspaceTriggerChannel(existing.channel_id);
  }

  const channel = await ensureWorkspaceTriggerChannel({
    workspaceId: input.workspaceId,
    toolkit,
    connectedAccountId,
    composioTriggerSlug,
  });

  const webhook = await ensureComposioWebhookSubscription();
  if (!webhook.configured) {
    console.warn("[integrations/composio] trigger registered but webhook delivery may not work", {
      loopId: input.loopId,
      reason: webhook.reason,
      webhookUrl: webhook.webhookUrl,
    });
  }

  return upsertLoopTriggerSubscription({
    loopId: input.loopId,
    workspaceId: input.workspaceId,
    channelId: channel.id,
  });
}

export async function unregisterLoopEventTrigger(loopId: string): Promise<void> {
  const channelId = await deactivateLoopTriggerSubscription(loopId);
  if (channelId) {
    await releaseWorkspaceTriggerChannel(channelId);
  }
}

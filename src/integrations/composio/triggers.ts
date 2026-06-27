import type { AuthContext } from "../../domain/auth/index.js";
import { isComposioTriggerSlugFormat } from "../../loops/event-trigger.js";
import { lookupStaticTriggerSlug } from "../../loops/trigger-catalog.js";
import {
  deactivateLoopTriggerSubscription,
  getLoopTriggerSubscription,
  releaseWorkspaceTriggerChannel,
  type LoopTriggerSubscriptionRow,
} from "./trigger-channels.js";
import { resolveToolkitSlug } from "./auth.js";
import { getComposioClient, isComposioConfigured, toObjectRecord } from "./client.js";

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

/** Catalogue helper for Conductor — static map, then exact slug, then fuzzy match. */
export async function resolveTriggerSlugWithCatalog(
  toolkit: string,
  eventTypeOrSlug: string,
): Promise<string> {
  const normalizedToolkit = await resolveToolkitSlug(toolkit);
  const hint = eventTypeOrSlug.trim();

  const fromStatic = lookupStaticTriggerSlug(normalizedToolkit, hint);
  if (fromStatic) return fromStatic;

  const available = await listComposioTriggerTypes(normalizedToolkit);

  const fromExactSlug = pickAvailableSlug(hint, available);
  if (fromExactSlug) return fromExactSlug;

  let best: { slug: string; score: number } | null = null;
  for (const row of available) {
    const score = scoreTriggerSlugMatch(hint, row.slug, row.name);
    if (!best || score > best.score) best = { slug: row.slug, score };
  }
  if (best && best.score >= MIN_TRIGGER_SCORE) return best.slug;

  throw new Error(
    `No Composio trigger for ${normalizedToolkit}/${hint}. ` +
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

export async function resolveCanonicalTriggerSlug(
  toolkit: string,
  input: { composioSlug?: string; eventType?: string },
): Promise<string> {
  const resolvedToolkit = await resolveToolkitSlug(toolkit);
  const composioSlug = input.composioSlug?.trim() ?? "";
  const eventType = input.eventType?.trim() ?? "";

  if (composioSlug && isComposioTriggerSlugFormat(composioSlug)) {
    return validateComposioTriggerSlug(resolvedToolkit, composioSlug);
  }

  const hints = [composioSlug, eventType].filter(Boolean);
  for (const hint of hints) {
    const staticSlug = lookupStaticTriggerSlug(resolvedToolkit, hint);
    if (staticSlug) {
      return validateComposioTriggerSlug(resolvedToolkit, staticSlug);
    }
  }

  const primaryHint = hints[0];
  if (!primaryHint) {
    const available = await listComposioTriggerTypes(resolvedToolkit);
    throw new Error(
      `Event trigger requires composioSlug or eventType for ${resolvedToolkit}. ` +
        `Available: ${available.map((row) => row.slug).join(", ") || "none"}`,
    );
  }

  return resolveTriggerSlugWithCatalog(resolvedToolkit, primaryHint);
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
  composioSlug?: string;
  eventType?: string;
}): Promise<LoopTriggerSubscriptionRow & import("./event-trigger-provision.js").EventTriggerProvisionReceipt> {
  const { provisionEventTrigger } = await import("./event-trigger-provision.js");
  const receipt = await provisionEventTrigger(input);
  const subscription = await getLoopTriggerSubscription(input.loopId);
  if (!subscription) {
    throw new Error("Loop trigger subscription missing after provision");
  }
  return { ...subscription, ...receipt };
}

export async function unregisterLoopEventTrigger(loopId: string): Promise<void> {
  const channelId = await deactivateLoopTriggerSubscription(loopId);
  if (channelId) {
    await releaseWorkspaceTriggerChannel(channelId);
  }
}

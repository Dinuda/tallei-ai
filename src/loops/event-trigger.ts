import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import {
  listComposioTriggerTypes,
  resolveTriggerSlugWithCatalog,
  validateComposioTriggerSlug,
} from "../integrations/composio/triggers.js";
import type { LoopSpec, SpecPatch, TriggerConfig } from "./spec.js";

/** Composio trigger type slugs are uppercase identifiers, not toolkit names like `gmail`. */
export const COMPOSIO_TRIGGER_SLUG_PATTERN = /^[A-Z][A-Z0-9_]+$/;

export type EventTriggerConfig = Extract<TriggerConfig, { kind: "event" }>;

export function isComposioTriggerSlugFormat(slug: string): boolean {
  const trimmed = slug.trim();
  return trimmed.length > 0 && COMPOSIO_TRIGGER_SLUG_PATTERN.test(trimmed);
}

export function isToolkitSlugMasqueradingAsTrigger(source: string, composioSlug: string): boolean {
  const slug = composioSlug.trim();
  if (!slug) return false;
  return normalizeToolkitSlug(slug) === normalizeToolkitSlug(source) && !isComposioTriggerSlugFormat(slug);
}

export function eventTriggerResolutionHint(source: string): string {
  return `Call listTriggers({ toolkit: "${source}" }) and set composioSlug to the exact slug (e.g. GMAIL_NEW_GMAIL_MESSAGE). source is the connector; composioSlug is the Composio trigger type.`;
}

export function validateEventTriggerShape(source: string, composioSlug: string): string | null {
  const slug = composioSlug.trim();
  if (!slug) return "trigger.composioSlug is required for event triggers";
  if (isToolkitSlugMasqueradingAsTrigger(source, slug)) {
    return `composioSlug "${slug}" is the connector toolkit, not a Composio trigger slug. ${eventTriggerResolutionHint(source)}`;
  }
  if (!isComposioTriggerSlugFormat(slug)) {
    return `composioSlug must be an uppercase Composio trigger slug (e.g. GMAIL_NEW_GMAIL_MESSAGE). ${eventTriggerResolutionHint(source)}`;
  }
  return null;
}

export function isEventTriggerReadyForCompile(source: string, composioSlug: string): boolean {
  return validateEventTriggerShape(source, composioSlug) === null;
}

export async function resolveEventTriggerSlug(
  source: string,
  composioSlugOrHint: string,
): Promise<string> {
  return resolveTriggerSlugWithCatalog(source, composioSlugOrHint);
}

export async function canonicalizeEventTrigger(
  trigger: EventTriggerConfig,
): Promise<EventTriggerConfig> {
  const source = trigger.source.trim();
  const candidate = trigger.composioSlug.trim();
  if (!source || !candidate) return trigger;

  const shapeError = validateEventTriggerShape(source, candidate);
  if (shapeError && isToolkitSlugMasqueradingAsTrigger(source, candidate)) {
    throw new Error(shapeError);
  }

  const composioSlug = await resolveEventTriggerSlug(source, candidate);
  return { ...trigger, composioSlug };
}

export async function canonicalizeEventTriggerInSpec(spec: LoopSpec): Promise<LoopSpec> {
  if (spec.trigger.kind !== "event") return spec;
  return {
    ...spec,
    trigger: await canonicalizeEventTrigger(spec.trigger),
  };
}

export async function resolveEventTriggerPatch(
  current: LoopSpec,
  patch: SpecPatch,
): Promise<SpecPatch> {
  if (patch.trigger?.kind !== "event") return patch;

  const source = patch.trigger.source?.trim()
    || (current.trigger.kind === "event" ? current.trigger.source : "");
  const candidate = patch.trigger.composioSlug?.trim()
    || (current.trigger.kind === "event" ? current.trigger.composioSlug : "");

  if (!source || !candidate) return patch;

  const shapeError = validateEventTriggerShape(source, candidate);
  if (shapeError && !isComposioTriggerSlugFormat(candidate)) {
    throw new Error(shapeError);
  }

  const composioSlug = await resolveEventTriggerSlug(source, candidate);
  return {
    ...patch,
    trigger: { ...patch.trigger, composioSlug },
  };
}

export async function validateEventTriggerForCompile(
  source: string,
  composioSlug: string,
): Promise<string> {
  const shapeError = validateEventTriggerShape(source, composioSlug);
  if (shapeError) throw new Error(shapeError);
  return validateComposioTriggerSlug(source, composioSlug);
}

export async function listEventTriggersForToolkit(toolkit: string) {
  const source = await resolveToolkitSlug(toolkit);
  const triggers = await listComposioTriggerTypes(source);
  return { toolkit: source, triggers };
}

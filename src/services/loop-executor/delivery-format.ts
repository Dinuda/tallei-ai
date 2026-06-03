/**
 * delivery-format.ts — Resolve content formatters for outbound delivery steps.
 */

import { newsletterDeliveryFormatter } from "./presets/newsletter.js";
import { getLoopPreset } from "./presets/registry.js";
import type { DeliveryContentFormatter, LoopDefinition } from "./types.js";

/** Heuristic for subscriber-facing newsletter markdown (works even on legacy loop definitions). */
export function looksLikeNewsletterContent(body: string): boolean {
  const sample = body.trim().slice(0, 4000);
  if (!sample) return false;
  return /\*\*[^*\n]{3,}\*\*/.test(sample)
    || /^#{1,6}\s+\S/m.test(sample)
    || /^\*\*subject:/im.test(sample)
    || /\bhey product builders\b/i.test(sample);
}

/** Newsletter loops use subscriber formatting + React Email for delivery. */
export function isNewsletterLoopDefinition(definition: LoopDefinition): boolean {
  const preset = getLoopPreset(definition.presetId);
  if (preset?.id === "newsletter") return true;
  const integrations = new Set(definition.allowedIntegrations.map((integration) => integration.trim().toLowerCase()));
  if (integrations.has("react_email")) return true;
  const toolRefs = new Set((definition.allowedToolRefs ?? []).map((ref) => ref.trim()));
  if (toolRefs.has("internal.resend_broadcast") || toolRefs.has("internal.react_email_template")) return true;
  return /\bnewsletter\b/i.test(definition.goal);
}

const plainDeliveryFormatter: DeliveryContentFormatter = {
  sanitizeBody: (raw) => raw.trim(),
  formatForDelivery: (raw) => ({
    subject: null,
    text: raw,
    html: `<div style="font-family:sans-serif;white-space:pre-wrap;">${raw.replace(/</g, "&lt;")}</div>`,
  }),
  formatForBroadcast: (formatted) => ({ text: formatted.text, html: formatted.html }),
};

export function resolveDeliveryFormatter(
  definition: LoopDefinition,
  deliveryBody?: string,
): DeliveryContentFormatter {
  if (isNewsletterLoopDefinition(definition)) return newsletterDeliveryFormatter;
  if (deliveryBody && looksLikeNewsletterContent(deliveryBody)) return newsletterDeliveryFormatter;
  return plainDeliveryFormatter;
}

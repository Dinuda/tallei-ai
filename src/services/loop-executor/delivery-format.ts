/**
 * delivery-format.ts — Pluggable delivery formatter registry.
 *
 * Formatters are registered by preset ID or delivery type.
 * The newsletter formatter is registered at module load.
 */

import { getLoopPreset } from "./presets/registry.js";
import type { DeliveryContentFormatter, LoopDefinition } from "./types.js";

const formatters = new Map<string, DeliveryContentFormatter>();

export function registerDeliveryFormatter(key: string, formatter: DeliveryContentFormatter): void {
  formatters.set(key, formatter);
}

export function getDeliveryFormatter(key: string): DeliveryContentFormatter | undefined {
  return formatters.get(key);
}

/** Newsletter loops use subscriber formatting + React Email for delivery. */
export function isNewsletterLoopDefinition(definition: LoopDefinition): boolean {
  const preset = getLoopPreset(definition.presetId);
  if (preset?.id === "newsletter") return true;
  return false;
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

export { plainDeliveryFormatter };

export function resolveDeliveryFormatter(
  definition: LoopDefinition,
  _deliveryBody?: string,
): DeliveryContentFormatter {
  if (definition.presetId) {
    const registered = formatters.get(definition.presetId);
    if (registered) return registered;
  }

  const deliveryType = definition.deliveryType;
  if (typeof deliveryType === "string") {
    const registered = formatters.get(deliveryType);
    if (registered) return registered;
  }

  if (isNewsletterLoopDefinition(definition)) {
    const newsletter = formatters.get("newsletter");
    if (newsletter) return newsletter;
  }

  return plainDeliveryFormatter;
}

/**
 * presets/registry.ts — Maps `LoopDefinition.presetId` to built-in roster strategies.
 */

import type { LoopDefinition, LoopPreset } from "../types.js";
import { NEWSLETTER_PRESET_TOOL_REFS, newsletterPreset } from "./newsletter.js";

const PRESETS: Record<string, LoopPreset> = {
  [newsletterPreset.id]: newsletterPreset,
  /** @deprecated Use presetId `newsletter` instead of template newsletter_v1 */
  newsletter_v1: newsletterPreset,
};

export function getLoopPreset(presetId: string | undefined): LoopPreset | null {
  if (!presetId?.trim()) return null;
  return PRESETS[presetId.trim()] ?? null;
}

export function resolveLoopPreset(definition: LoopDefinition): LoopPreset | null {
  const explicit = getLoopPreset(definition.presetId);
  if (explicit) return explicit;
  if (/\bnewsletter\b/i.test(definition.goal)) return newsletterPreset;
  if (definition.allowedToolRefs?.includes("internal.resend_broadcast")) return newsletterPreset;
  return null;
}

export function listLoopPresets(): LoopPreset[] {
  return [newsletterPreset];
}

/** Tool refs required by the resolved preset roster (sync; used for allowlist repair). */
export function presetToolRefsForDefinition(definition: LoopDefinition): string[] {
  const preset = resolveLoopPreset(definition);
  if (!preset) return [];
  if (preset.id === "newsletter" || preset.id === "newsletter_v1") {
    return [...NEWSLETTER_PRESET_TOOL_REFS];
  }
  return [];
}

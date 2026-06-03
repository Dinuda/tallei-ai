/**
 * presets/registry.ts — Maps `LoopDefinition.presetId` to built-in roster strategies.
 */

import type { LoopPreset } from "../types.js";
import { newsletterPreset } from "./newsletter.js";

const PRESETS: Record<string, LoopPreset> = {
  [newsletterPreset.id]: newsletterPreset,
  /** @deprecated Use presetId `newsletter` instead of template newsletter_v1 */
  newsletter_v1: newsletterPreset,
};

export function getLoopPreset(presetId: string | undefined): LoopPreset | null {
  if (!presetId?.trim()) return null;
  return PRESETS[presetId.trim()] ?? null;
}

export function listLoopPresets(): LoopPreset[] {
  return [newsletterPreset];
}

/**
 * external-action-handlers.ts — Pluggable external action dispatch registry.
 *
 * External actions are plan-level stages (kind: "external_action") that
 * execute a catalog tool after agent stages complete. Each toolRef
 * maps to a handler that gathers artifacts, executes, and advances the run.
 */

import type { LoopRunContext } from "./run-context.js";
import type { LoopExternalActionStage } from "./types.js";

export type ExternalActionHandler = (
  context: LoopRunContext,
  task: Record<string, unknown>,
  stage: LoopExternalActionStage,
) => Promise<{ status: string }>;

const registry = new Map<string, ExternalActionHandler>();

export function registerExternalActionHandler(ref: string, handler: ExternalActionHandler): void {
  registry.set(ref, handler);
}

export function getExternalActionHandler(ref: string): ExternalActionHandler | undefined {
  return registry.get(ref);
}

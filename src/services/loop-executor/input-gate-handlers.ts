/**
 * input-gate-handlers.ts — Registry for structured input gate parsing.
 */

import type { LoopInputGateStage } from "./types.js";

export type InputGateHandlerResult = {
  body: string;
  data: Record<string, unknown>;
  response?: Record<string, unknown>;
};

export type InputGateHandler = (input: {
  value: string;
  stage: LoopInputGateStage;
}) => Promise<InputGateHandlerResult> | InputGateHandlerResult;

const registry = new Map<string, InputGateHandler>();

export function registerInputGateHandler(kind: string, handler: InputGateHandler): void {
  registry.set(kind, handler);
}

export function getInputGateHandler(kind: string): InputGateHandler | undefined {
  return registry.get(kind);
}

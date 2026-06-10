import {
  loopArchitectOutputSchema,
  type LoopArchitectOutput,
  type NoSlopSpecSnapshot,
} from "./contracts.js";

/**
 * Keep architect output explicit. Earlier versions silently rewrote agent gates,
 * roles, and render targets based on heuristic labels; dynamic workflows should
 * be validated by the critic instead of repaired into a fixed shape.
 */
export function normalizeArchitectOutput(
  design: LoopArchitectOutput,
  _noSlopSpec?: NoSlopSpecSnapshot,
): LoopArchitectOutput {
  return loopArchitectOutputSchema.parse(design);
}

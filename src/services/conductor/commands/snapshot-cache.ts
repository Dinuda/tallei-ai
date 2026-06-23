import { createHash } from "crypto";

import type { NoSlopSpecSnapshot } from "../contracts/spec-contracts.js";
import type { LoopBuildContract } from "../domain/build-contract.js";

const cache = new Map<string, { fingerprint: string; snapshot: NoSlopSpecSnapshot }>();

function fingerprint(buildContract: LoopBuildContract, goal: string): string {
  return createHash("sha256")
    .update(goal)
    .update(JSON.stringify(buildContract))
    .digest("hex");
}

export function getCachedRuntimeSnapshot(
  sessionId: string,
  buildContract: LoopBuildContract,
  goal: string,
): NoSlopSpecSnapshot | null {
  const entry = cache.get(sessionId);
  if (!entry) return null;
  if (entry.fingerprint !== fingerprint(buildContract, goal)) return null;
  return entry.snapshot;
}

export function setCachedRuntimeSnapshot(
  sessionId: string,
  buildContract: LoopBuildContract,
  goal: string,
  snapshot: NoSlopSpecSnapshot,
): void {
  cache.set(sessionId, { fingerprint: fingerprint(buildContract, goal), snapshot });
}

export function clearCachedRuntimeSnapshot(sessionId: string): void {
  cache.delete(sessionId);
}

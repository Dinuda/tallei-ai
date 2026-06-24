import type { LoopMinerSummary } from "./core/loop-miner.types.js";

export async function queueLoopMinerRunForUser(_auth: unknown, _input?: unknown): Promise<LoopMinerSummary & { runId?: string }> {
  throw new Error("Loop miner is not available");
}

export async function listLoopMinerRunsForUser(_auth: unknown, _input?: unknown): Promise<LoopMinerSummary[]> {
  return [];
}

export async function getLoopMinerRunStatusForUser(_auth: unknown, _runId?: unknown): Promise<LoopMinerSummary | null> {
  return null;
}

export async function getLoopMinerRunEmbeddingMapForUser(_auth: unknown, _runId?: unknown): Promise<Record<string, unknown>> {
  return {};
}

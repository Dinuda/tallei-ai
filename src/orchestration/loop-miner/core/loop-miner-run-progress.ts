import { createLogger } from "../../../observability/index.js";

export interface LoopMinerPhaseTiming {
  phase: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "skipped";
  details?: Record<string, unknown>;
}

export interface LoopMinerProgressSnapshot {
  phaseTimings: LoopMinerPhaseTiming[];
  totalElapsedMs: number;
}

const logger = createLogger({ baseFields: { component: "loop_miner" } });

export class LoopMinerRunProgress {
  private readonly runStartedAt = Date.now();
  private readonly phases: LoopMinerPhaseTiming[] = [];
  private readonly activePhaseIndex = new Map<string, number>();

  constructor(private readonly runId: string) {}

  elapsedMs(): number {
    return Date.now() - this.runStartedAt;
  }

  startPhase(phase: string, details?: Record<string, unknown>): void {
    const elapsedMs = this.elapsedMs();
    logger.info("loop miner phase started", {
      runId: this.runId,
      phase,
      elapsedMs,
      ...details,
    });
    const entry: LoopMinerPhaseTiming = {
      phase,
      startedAt: new Date().toISOString(),
      status: "running",
      details,
    };
    this.phases.push(entry);
    this.activePhaseIndex.set(phase, this.phases.length - 1);
  }

  endPhase(phase: string, details?: Record<string, unknown>): void {
    const index = this.activePhaseIndex.get(phase);
    if (index === undefined) return;
    const entry = this.phases[index];
    if (!entry) return;
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - Date.parse(entry.startedAt);
    entry.endedAt = endedAt;
    entry.durationMs = durationMs;
    entry.status = "completed";
    entry.details = { ...(entry.details ?? {}), ...(details ?? {}) };
    this.activePhaseIndex.delete(phase);
    logger.info("loop miner phase completed", {
      runId: this.runId,
      phase,
      durationMs,
      elapsedMs: this.elapsedMs(),
      ...details,
    });
  }

  skipPhase(phase: string, reason: string, details?: Record<string, unknown>): void {
    const elapsedMs = this.elapsedMs();
    logger.info("loop miner phase skipped", {
      runId: this.runId,
      phase,
      reason,
      elapsedMs,
      ...details,
    });
    this.phases.push({
      phase,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      status: "skipped",
      details: { reason, ...(details ?? {}) },
    });
  }

  failPhase(phase: string, error: unknown, details?: Record<string, unknown>): void {
    const index = this.activePhaseIndex.get(phase);
    const message = error instanceof Error ? error.message : String(error);
    if (index !== undefined) {
      const entry = this.phases[index];
      if (entry) {
        entry.endedAt = new Date().toISOString();
        entry.durationMs = Date.now() - Date.parse(entry.startedAt);
        entry.status = "failed";
        entry.details = { ...(entry.details ?? {}), error: message, ...(details ?? {}) };
      }
      this.activePhaseIndex.delete(phase);
    }
    logger.error("loop miner phase failed", {
      runId: this.runId,
      phase,
      error: message,
      elapsedMs: this.elapsedMs(),
      ...details,
    });
  }

  step(message: string, details?: Record<string, unknown>): void {
    logger.info("loop miner progress", {
      runId: this.runId,
      message,
      elapsedMs: this.elapsedMs(),
      ...details,
    });
  }

  snapshot(): LoopMinerProgressSnapshot {
    return {
      phaseTimings: this.phases.map((phase) => ({ ...phase })),
      totalElapsedMs: this.elapsedMs(),
    };
  }
}

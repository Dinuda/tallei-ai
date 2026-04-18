import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface TraceContext {
  readonly correlationId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function createCorrelationId(): string {
  return randomUUID();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return runWithTraceContext({ correlationId }, fn);
}

export function currentTraceContext(): TraceContext | null {
  return traceStorage.getStore() ?? null;
}

export function currentCorrelationId(): string | null {
  return currentTraceContext()?.correlationId ?? null;
}

export function ensureCorrelationId(): string {
  return currentCorrelationId() ?? createCorrelationId();
}

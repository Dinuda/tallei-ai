import type { CircuitBreaker } from "./circuit-breaker.js";
import { retry, type RetryPolicy } from "./retry.js";
import { withTimeout } from "./timeout.js";

export interface Policy<T> {
  execute(op: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface PolicyMetricsHooks {
  onSuccess?: (durationMs: number) => void;
  onFailure?: (error: unknown, durationMs: number) => void;
}

export interface ComposePolicyOptions {
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly circuitBreaker?: CircuitBreaker;
  readonly metrics?: PolicyMetricsHooks;
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function composePolicy<T>(options: ComposePolicyOptions): Policy<T> {
  const timeoutMs = options.timeoutMs;

  const runSingle = async (
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> => {
    if (timeoutMs === undefined) {
      return operation(signal);
    }
    return withTimeout((timeoutSignal) => operation(timeoutSignal), timeoutMs, { signal });
  };

  return {
    async execute(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const startedAt = nowMs();
      const runWithRetry = async (): Promise<T> => {
        if (!options.retryPolicy) {
          return runSingle(operation, new AbortController().signal);
        }

        return retry(
          (signal) => runSingle(operation, signal),
          options.retryPolicy
        );
      };

      try {
        const value = options.circuitBreaker
          ? await options.circuitBreaker.execute(() => runWithRetry())
          : await runWithRetry();

        options.metrics?.onSuccess?.(nowMs() - startedAt);
        return value;
      } catch (error) {
        options.metrics?.onFailure?.(error, nowMs() - startedAt);
        throw error;
      }
    },
  };
}

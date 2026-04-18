export type RetryJitter = "none" | "equal" | "full";

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: RetryJitter;
  readonly shouldRetry?: (error: unknown) => boolean;
  readonly onRetry?: (ctx: RetryAttemptContext) => void;
}

export interface RetryAttemptContext {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  readonly signal?: AbortSignal;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortError("Operation aborted");
}

function computeBaseDelayMs(policy: RetryPolicy, retryIndex: number): number {
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, retryIndex - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

export function computeJitteredDelayMs(policy: RetryPolicy, retryIndex: number): number {
  const baseDelayMs = computeBaseDelayMs(policy, retryIndex);
  if (policy.jitter === "none") return baseDelayMs;
  const random = Math.random();
  if (policy.jitter === "equal") {
    return Math.floor(baseDelayMs / 2 + random * (baseDelayMs / 2));
  }
  return Math.floor(random * baseDelayMs);
}

async function sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) return;
  ensureNotAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError("Retry wait aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retry<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options: RetryOptions = {}
): Promise<T> {
  const outerSignal = options.signal;
  const shouldRetry = policy.shouldRetry ?? (() => true);

  let attempt = 0;

  while (true) {
    attempt += 1;
    ensureNotAborted(outerSignal);

    const attemptController = new AbortController();
    const onOuterAbort = (): void => {
      attemptController.abort();
    };
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      return await operation(attemptController.signal, attempt);
    } catch (error) {
      const canRetry = attempt <= policy.maxRetries && shouldRetry(error);
      if (!canRetry) {
        throw error;
      }

      const retryIndex = attempt;
      const delayMs = computeJitteredDelayMs(policy, retryIndex);
      policy.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, outerSignal);
    } finally {
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

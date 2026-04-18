import { AppError } from "../shared/errors/base.js";

export interface TimeoutOptions {
  readonly signal?: AbortSignal;
  readonly message?: string;
}

export class TimeoutError extends AppError {
  readonly kind = "timeout";
  readonly retriable = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Operation timed out after ${timeoutMs}ms`, options);
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: TimeoutOptions = {}
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new TimeoutError(timeoutMs, options.message ?? "Timeout must be greater than 0ms");
  }

  const parentSignal = options.signal;
  const controller = new AbortController();

  let timeoutTriggered = false;
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  const onParentAbort = (): void => {
    controller.abort();
  };

  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timeoutTriggered) {
      throw new TimeoutError(timeoutMs, options.message, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

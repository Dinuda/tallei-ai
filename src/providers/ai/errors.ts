import type { OpenAIError } from "openai/error";
import {
  ProviderAuthError,
  ProviderFatalError,
  ProviderInvalidRequestError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  ProviderTransientError,
  type ProviderName,
} from "../../shared/errors/provider-errors.js";
import { AppError } from "../../shared/errors/base.js";
import { TimeoutError } from "../../resilience/timeout.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseStatus(error: unknown): number | null {
  const status = asRecord(error)["status"];
  if (typeof status === "number") {
    return status;
  }
  return null;
}

function parseCode(error: unknown): string {
  const code = asRecord(error)["code"];
  return typeof code === "string" ? code : "";
}

function parseName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function parseMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown provider error");
}

function parseType(error: unknown): string {
  const type = asRecord(error)["type"];
  return typeof type === "string" ? type : "";
}

function parseCause(error: unknown): unknown {
  return asRecord(error)["cause"];
}

function chainHas(
  error: unknown,
  predicate: (input: { message: string; name: string; code: string; type: string }) => boolean
): boolean {
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 6) {
    const message = parseMessage(current).toLowerCase();
    const name = parseName(current).toLowerCase();
    const code = parseCode(current).toLowerCase();
    const type = parseType(current).toLowerCase();
    if (predicate({ message, name, code, type })) return true;
    current = parseCause(current);
    depth += 1;
  }

  return false;
}

export function mapProviderError(provider: ProviderName, error: unknown): Error {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof TimeoutError) {
    return new ProviderTimeoutError(provider, error.message, { cause: error });
  }

  const message = parseMessage(error);
  const status = parseStatus(error);
  const code = parseCode(error).toLowerCase();
  const type = parseType(error).toLowerCase();
  const name = parseName(error).toLowerCase();

  const timeoutLike = chainHas(error, ({ message: chainMessage, name: chainName, code: chainCode, type: chainType }) =>
    chainCode.includes("timeout") ||
    chainType.includes("timeout") ||
    chainName.includes("abort") ||
    chainName.includes("timeout") ||
    /timed out|etimedout|aborted|timeout/i.test(chainMessage)
  );

  if (timeoutLike) {
    return new ProviderTimeoutError(provider, message, { cause: error });
  }

  if (status === 429 || code === "rate_limit_exceeded" || code === "insufficient_quota") {
    return new ProviderRateLimitedError(provider, message, { cause: error });
  }

  if (status === 401 || status === 403 || code.includes("auth")) {
    return new ProviderAuthError(provider, message, { cause: error });
  }

  if (status === 400 || status === 404 || status === 422 || code.includes("invalid")) {
    return new ProviderInvalidRequestError(provider, message, { cause: error });
  }

  if (status !== null && status >= 500) {
    return new ProviderTransientError(provider, message, { cause: error });
  }

  const connectionLike = chainHas(error, ({ message: chainMessage, name: chainName, code: chainCode, type: chainType }) =>
    chainCode === "api_connection_error" ||
    chainType === "api_connection_error" ||
    chainCode === "internal_server_error" ||
    chainName.includes("apiconnectionerror") ||
    /connection error|fetch failed|network|socket|econn|enotfound|no route to host|ehostunreach|eai_again|temporar/i.test(chainMessage)
  );

  if (connectionLike || code === "api_connection_error" || type === "api_connection_error" || code === "internal_server_error") {
    return new ProviderTransientError(provider, message, { cause: error });
  }

  if (error instanceof Error && /network|socket|econn|enotfound|temporar/i.test(error.message)) {
    return new ProviderTransientError(provider, message, { cause: error });
  }

  return new ProviderFatalError(provider, message, { cause: error });
}

export function isRetriableProviderError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.retriable;
  }

  const mapped = mapProviderError("unknown", error as OpenAIError);
  return mapped instanceof AppError ? mapped.retriable : false;
}

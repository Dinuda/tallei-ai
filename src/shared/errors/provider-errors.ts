import { AppError } from "./base.js";

export type ProviderName = "openai" | "ollama" | "google" | "qdrant" | "redis" | "unknown";

abstract class ProviderError extends AppError {
  abstract readonly kind:
    | "provider_timeout"
    | "provider_rate_limited"
    | "provider_auth_error"
    | "provider_invalid_request"
    | "provider_transient"
    | "provider_fatal"
    | "circuit_open";

  readonly provider: ProviderName;

  protected constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.provider = provider;
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly kind = "provider_timeout";
  readonly retriable = true;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class ProviderRateLimitedError extends ProviderError {
  readonly kind = "provider_rate_limited";
  readonly retriable = true;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class ProviderAuthError extends ProviderError {
  readonly kind = "provider_auth_error";
  readonly retriable = false;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class ProviderInvalidRequestError extends ProviderError {
  readonly kind = "provider_invalid_request";
  readonly retriable = false;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class ProviderTransientError extends ProviderError {
  readonly kind = "provider_transient";
  readonly retriable = true;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class ProviderFatalError extends ProviderError {
  readonly kind = "provider_fatal";
  readonly retriable = false;

  constructor(provider: ProviderName, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
  }
}

export class CircuitOpenError extends ProviderError {
  readonly kind = "circuit_open";
  readonly retriable = true;

  constructor(provider: ProviderName, message: string) {
    super(provider, message);
  }
}

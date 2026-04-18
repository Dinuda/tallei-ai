import { AppError } from "./base.js";

export class DomainError extends AppError {
  readonly kind = "domain_error";
  readonly retriable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";

  constructor(message: string) {
    super(message);
  }
}

export abstract class AppError extends Error {
  abstract readonly kind: string;
  abstract readonly retriable: boolean;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
  }
}

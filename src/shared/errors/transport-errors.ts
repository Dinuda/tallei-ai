import { AppError } from "./base.js";

export class HttpError extends AppError {
  readonly kind = "http_error";
  readonly retriable: boolean;
  readonly statusCode: number;

  constructor(statusCode: number, message: string, options?: { retriable?: boolean; cause?: unknown }) {
    super(message, options);
    this.statusCode = statusCode;
    this.retriable = options?.retriable ?? (statusCode >= 500 && statusCode < 600);
  }
}

export class McpError extends AppError {
  readonly kind = "mcp_error";
  readonly retriable: boolean;
  readonly code: string;

  constructor(code: string, message: string, options?: { retriable?: boolean; cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.retriable = options?.retriable ?? false;
  }
}

import { currentCorrelationId } from "./tracing.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly baseFields?: LogFields;
}

interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

function shouldEmit(currentLevel: LogLevel, level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

function emit(level: LogLevel, record: LogRecord): void {
  const serialized = JSON.stringify(record);
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.log(serialized);
}

class JsonLogger implements Logger {
  private readonly level: LogLevel;
  private readonly baseFields: LogFields;

  constructor(level: LogLevel, baseFields: LogFields = {}) {
    this.level = level;
    this.baseFields = baseFields;
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.level, { ...this.baseFields, ...fields });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.log("error", message, fields);
  }

  private log(level: LogLevel, message: string, fields: LogFields): void {
    if (!shouldEmit(this.level, level)) return;

    const correlationId = currentCorrelationId() ?? undefined;
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(correlationId ? { correlationId } : {}),
      ...this.baseFields,
      ...fields,
    };

    emit(level, record);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new JsonLogger(options.level ?? "info", options.baseFields ?? {});
}

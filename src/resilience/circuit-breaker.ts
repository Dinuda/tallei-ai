import { CircuitOpenError } from "../shared/errors/provider-errors.js";

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly state: CircuitBreakerState;
  readonly failureCount: number;
  readonly halfOpenSuccessCount: number;
  readonly openedAtMs: number | null;
  readonly nextProbeAtMs: number | null;
}

export interface CircuitBreaker {
  readonly state: CircuitBreakerState;
  execute<T>(op: () => Promise<T>): Promise<T>;
  snapshot(): CircuitBreakerSnapshot;
}

export interface CircuitBreakerOptions {
  readonly name: string;
  readonly failureThreshold: number;
  readonly coolOffMs: number;
  readonly halfOpenSuccessThreshold: number;
  readonly shouldCountFailure?: (error: unknown) => boolean;
}

export class BasicCircuitBreaker implements CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly coolOffMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly shouldCountFailure: (error: unknown) => boolean;

  private _state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private halfOpenSuccessCount = 0;
  private openedAtMs: number | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.coolOffMs = Math.max(1, options.coolOffMs);
    this.halfOpenSuccessThreshold = Math.max(1, options.halfOpenSuccessThreshold);
    this.shouldCountFailure = options.shouldCountFailure ?? (() => true);
  }

  get state(): CircuitBreakerState {
    this.updateStateByTime();
    return this._state;
  }

  async execute<T>(op: () => Promise<T>): Promise<T> {
    this.updateStateByTime();

    if (this._state === "open") {
      throw new CircuitOpenError("unknown", `Circuit ${this.name} is open`);
    }

    try {
      const value = await op();
      this.onSuccess();
      return value;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    this.updateStateByTime();
    return {
      name: this.name,
      state: this._state,
      failureCount: this.failureCount,
      halfOpenSuccessCount: this.halfOpenSuccessCount,
      openedAtMs: this.openedAtMs,
      nextProbeAtMs: this.openedAtMs === null ? null : this.openedAtMs + this.coolOffMs,
    };
  }

  private updateStateByTime(): void {
    if (this._state !== "open" || this.openedAtMs === null) {
      return;
    }

    if (Date.now() - this.openedAtMs < this.coolOffMs) {
      return;
    }

    this._state = "half_open";
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
  }

  private onSuccess(): void {
    if (this._state === "half_open") {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.close();
      }
      return;
    }

    if (this._state === "closed") {
      this.failureCount = 0;
    }
  }

  private onFailure(error: unknown): void {
    if (!this.shouldCountFailure(error)) {
      return;
    }

    if (this._state === "half_open") {
      this.open();
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this._state = "open";
    this.openedAtMs = Date.now();
    this.halfOpenSuccessCount = 0;
  }

  private close(): void {
    this._state = "closed";
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.openedAtMs = null;
  }
}

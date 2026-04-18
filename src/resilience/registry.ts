import { BasicCircuitBreaker, type CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";

export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, CircuitBreaker>();

  getOrCreate(key: string, options: Omit<CircuitBreakerOptions, "name">): CircuitBreaker {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const created = new BasicCircuitBreaker({ ...options, name: key });
    this.entries.set(key, created);
    return created;
  }

  snapshot(): Record<string, ReturnType<CircuitBreaker["snapshot"]>> {
    const output: Record<string, ReturnType<CircuitBreaker["snapshot"]>> = {};
    for (const [key, breaker] of this.entries.entries()) {
      output[key] = breaker.snapshot();
    }
    return output;
  }
}

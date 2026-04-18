import assert from "node:assert/strict";
import test from "node:test";

import { BasicCircuitBreaker } from "../../../src/resilience/circuit-breaker.js";
import { CircuitOpenError } from "../../../src/shared/errors/provider-errors.js";

test("circuit breaker opens after configured failures", async () => {
  const breaker = new BasicCircuitBreaker({
    name: "openai:chat",
    failureThreshold: 2,
    coolOffMs: 50,
    halfOpenSuccessThreshold: 1,
  });

  await assert.rejects(breaker.execute(async () => Promise.reject(new Error("fail-1"))), /fail-1/);
  await assert.rejects(breaker.execute(async () => Promise.reject(new Error("fail-2"))), /fail-2/);

  assert.equal(breaker.state, "open");

  await assert.rejects(
    breaker.execute(async () => "ok"),
    (error: unknown) => error instanceof CircuitOpenError
  );
});

test("circuit breaker transitions from open to half_open then closed", async () => {
  const breaker = new BasicCircuitBreaker({
    name: "openai:embed",
    failureThreshold: 1,
    coolOffMs: 5,
    halfOpenSuccessThreshold: 2,
  });

  await assert.rejects(breaker.execute(async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(breaker.state, "open");

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(breaker.state, "half_open");

  await breaker.execute(async () => "ok-1");
  assert.equal(breaker.state, "half_open");

  await breaker.execute(async () => "ok-2");
  assert.equal(breaker.state, "closed");
});

test("circuit breaker snapshot exposes state metadata", async () => {
  const breaker = new BasicCircuitBreaker({
    name: "qdrant:search",
    failureThreshold: 1,
    coolOffMs: 50,
    halfOpenSuccessThreshold: 1,
  });

  await assert.rejects(breaker.execute(async () => Promise.reject(new Error("down"))), /down/);

  const snapshot = breaker.snapshot();
  assert.equal(snapshot.name, "qdrant:search");
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.failureCount, 1);
  assert.equal(typeof snapshot.nextProbeAtMs, "number");
});

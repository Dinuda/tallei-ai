import assert from "node:assert/strict";
import test from "node:test";

import { BasicCircuitBreaker } from "../../../src/resilience/circuit-breaker.js";
import { composePolicy } from "../../../src/resilience/policy.js";

test("composePolicy applies retry + timeout and emits metrics", async () => {
  let attempts = 0;
  const metricEvents: string[] = [];

  const policy = composePolicy<string>({
    timeoutMs: 25,
    retryPolicy: {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: "none",
      shouldRetry: (error) => error instanceof Error && error.message === "transient",
    },
    metrics: {
      onSuccess: () => metricEvents.push("success"),
      onFailure: () => metricEvents.push("failure"),
    },
  });

  const result = await policy.execute(async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new Error("transient");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(metricEvents, ["success"]);
});

test("composePolicy respects circuit breaker open state", async () => {
  const breaker = new BasicCircuitBreaker({
    name: "openai:chat",
    failureThreshold: 1,
    coolOffMs: 50,
    halfOpenSuccessThreshold: 1,
  });

  const policy = composePolicy<string>({
    circuitBreaker: breaker,
  });

  await assert.rejects(policy.execute(async () => Promise.reject(new Error("first-failure"))), /first-failure/);
  assert.equal(breaker.state, "open");

  await assert.rejects(policy.execute(async () => "unreachable"), /Circuit/);
});

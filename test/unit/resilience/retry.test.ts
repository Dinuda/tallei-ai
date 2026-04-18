import assert from "node:assert/strict";
import test from "node:test";

import { retry } from "../../../src/resilience/retry.js";

test("retry retries transient failures then succeeds", async () => {
  let attempts = 0;

  const result = await retry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient");
      }
      return "ok";
    },
    {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitter: "none",
    }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("retry stops after max retries", async () => {
  let attempts = 0;

  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw new Error("always fails");
      },
      {
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: "none",
      }
    ),
    /always fails/
  );

  assert.equal(attempts, 3);
});

test("retry honors abort signal during backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;

  const pending = retry(
    async () => {
      attempts += 1;
      throw new Error("retry-me");
    },
    {
      maxRetries: 5,
      initialDelayMs: 50,
      maxDelayMs: 50,
      jitter: "none",
    },
    { signal: controller.signal }
  );

  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.name === "AbortError";
  });

  assert.equal(attempts, 1);
});

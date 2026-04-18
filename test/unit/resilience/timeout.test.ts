import assert from "node:assert/strict";
import test from "node:test";

import { TimeoutError, withTimeout } from "../../../src/resilience/timeout.js";

test("withTimeout returns result when operation completes in time", async () => {
  const result = await withTimeout(async () => "ok", 100);
  assert.equal(result, "ok");
});

test("withTimeout throws TimeoutError on expiration", async () => {
  await assert.rejects(
    withTimeout(
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
        return "never";
      },
      5
    ),
    (error: unknown) => error instanceof TimeoutError
  );
});

test("withTimeout respects parent abort signal", async () => {
  const controller = new AbortController();

  const pending = withTimeout(
    async (signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("parent aborted")), { once: true });
      });
      return "never";
    },
    100,
    { signal: controller.signal }
  );

  controller.abort();

  await assert.rejects(pending, /parent aborted/);
});

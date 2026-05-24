import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../../../src/config/index.js";
import { sendAdminSlackMessage } from "../../../src/infrastructure/notifications/admin-slack.js";

test("admin slack sender skips when webhook is unset", async () => {
  const originalUrl = config.adminSlackWebhookUrl;
  config.adminSlackWebhookUrl = "";
  try {
    const result = await sendAdminSlackMessage({ text: "hello" });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
  } finally {
    config.adminSlackWebhookUrl = originalUrl;
  }
});

test("admin slack sender posts text payload", async () => {
  const originalUrl = config.adminSlackWebhookUrl;
  const originalFetch = globalThis.fetch;
  let postedBody: unknown = null;
  config.adminSlackWebhookUrl = "https://hooks.slack.test/admin";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    postedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await sendAdminSlackMessage({ text: "Loop Miner completed" });
    assert.equal(result.sent, true);
    assert.equal(result.skipped, false);
    assert.deepEqual(postedBody, { text: "Loop Miner completed" });
  } finally {
    config.adminSlackWebhookUrl = originalUrl;
    globalThis.fetch = originalFetch;
  }
});

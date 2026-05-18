import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.INTERNAL_API_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.MEMORY_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "";
process.env.TALLEI_SIGNUP__RESEND_API_KEY = "resend-test-key";
process.env.TALLEI_SIGNUP__EMAIL_FROM_EMAIL = "noreply@tallei.test";
process.env.TALLEI_NOTIFICATIONS__EMAIL_ADAPTER = "resend";
process.env.TALLEI_NOTIFICATIONS__DELIVERY_MAX_ATTEMPTS = "3";
process.env.TALLEI_NOTIFICATIONS__DELIVERY_RETRY_BASE_MS = "1";

const [{ sendWorkflowSuggestionNotification }, db] = await Promise.all([
  import("../../../src/services/workflow-automation.js"),
  import("../../../src/infrastructure/db/index.js"),
]);

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "api_key" as const,
  plan: "pro" as const,
};

const suggestion = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Weekly Company Update Draft",
  reason: "You created similar company updates recently.",
  suggestedPrompt: "Want me to prepare this every Friday?",
  status: "pending" as const,
  confidence: 0.8,
  fingerprint: "company-update-weekly",
  triggerCount: 3,
  createdAt: new Date().toISOString(),
};

test("notification delivery succeeds after one retry", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalFetch = globalThis.fetch;

  const deliveryStatuses: string[] = [];
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO workflow_approval_tokens")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO notification_deliveries")) {
      const status = params?.[6];
      if (typeof status === "string") deliveryStatuses.push(status);
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: "temporary outage" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    await sendWorkflowSuggestionNotification({
      auth,
      suggestion,
      to: "user@example.com",
      channel: "email",
    });

    assert.equal(attempts, 2);
    assert.deepEqual(deliveryStatuses, ["queued", "failed", "queued", "sent"]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

test("notification delivery fails after max attempts", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalFetch = globalThis.fetch;

  const deliveryStatuses: string[] = [];
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO workflow_approval_tokens")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO notification_deliveries")) {
      const status = params?.[6];
      if (typeof status === "string") deliveryStatuses.push(status);
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "always failing" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      async () => sendWorkflowSuggestionNotification({
        auth,
        suggestion,
        to: "user@example.com",
        channel: "email",
      }),
      /Failed to deliver email approval prompt/
    );
    assert.equal(attempts, 3);
    assert.deepEqual(deliveryStatuses, ["queued", "failed", "queued", "failed", "queued", "failed"]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

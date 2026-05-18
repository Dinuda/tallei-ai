import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.INTERNAL_API_SECRET ??= "integration-secret";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.JWT_SECRET ??= "integration-jwt-secret";
process.env.MEMORY_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "";
process.env.TALLEI_NOTIFICATIONS__WHATSAPP_ADAPTER = "webhook";
process.env.TALLEI_NOTIFICATIONS__WHATSAPP_WEBHOOK_URL = "https://example.test/whatsapp";
process.env.TALLEI_NOTIFICATIONS__DELIVERY_MAX_ATTEMPTS = "2";
process.env.TALLEI_NOTIFICATIONS__DELIVERY_RETRY_BASE_MS = "1";

const [workflowAutomation, db] = await Promise.all([
  import("../../src/services/workflow-automation.js"),
  import("../../src/infrastructure/db/index.js"),
]);

test("daily intelligence sends top suggestion through preferred whatsapp channel", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalFetch = globalThis.fetch;

  const statuses: Array<{ channel: string; status: string }> = [];
  let createdSuggestionId: string | null = null;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO daily_intelligence_runs")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("SELECT content_text") && sql.includes("FROM ai_activity_events")) {
      return {
        rows: [{ content_text: "please prepare a company update for our weekly newsletter" }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("FROM workflow_suggestions") && sql.includes("status = 'pending'")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    if (sql.includes("FROM workflows") && sql.includes("status IN ('active', 'paused')")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    if (sql.includes("FROM workflow_suggestions") && sql.includes("status = 'dismissed'")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    if (sql.includes("SELECT COUNT(*)::int AS cnt")) {
      return { rows: [{ cnt: 3 }], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO workflow_suggestions")) {
      createdSuggestionId = typeof params?.[0] === "string" ? params[0] : null;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("SELECT kind, destination") && sql.includes("FROM notification_channels")) {
      return {
        rows: [
          { kind: "whatsapp", destination: "+15555550100" },
          { kind: "email", destination: "user@example.com" },
        ],
        rowCount: 2,
      } as unknown;
    }
    if (sql.includes("INSERT INTO workflow_approval_tokens")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO notification_deliveries")) {
      statuses.push({
        channel: String(params?.[3] ?? ""),
        status: String(params?.[6] ?? ""),
      });
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE daily_intelligence_runs")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/whatsapp") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected url" }), { status: 500 });
  }) as typeof globalThis.fetch;

  try {
    const result = await workflowAutomation.runDailyIntelligencePassForUserInternal(
      {
        tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authMode: "internal",
        plan: "pro",
      },
      { skipSdkLifecycle: true }
    );

    assert.equal(result.suggestionCount, 1);
    assert.ok(createdSuggestionId, "suggestion should be created");
    assert.deepEqual(statuses, [
      { channel: "whatsapp", status: "queued" },
      { channel: "whatsapp", status: "sent" },
    ]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

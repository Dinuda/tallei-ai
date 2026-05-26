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

const AUTH = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  authMode: "internal" as const,
  plan: "pro" as const,
};

test("daily intelligence sends top suggestion through preferred whatsapp channel", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalFetch = globalThis.fetch;

  const statuses: Array<{ channel: string; status: string }> = [];
  let createdSuggestionId: string | null = null;
  let completionMetadata: Record<string, unknown> | null = null;
  const dailyRunId = "11111111-1111-4111-8111-111111111111";

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("WITH lock_key AS") && sql.includes("INSERT INTO daily_intelligence_runs")) {
      return { rows: [{ inserted_id: dailyRunId, existing_id: null }], rowCount: 1 } as unknown;
    }
    if (sql.includes("COUNT(*)::int AS active_memory_count") && sql.includes("FROM memory_records")) {
      return { rows: [{ active_memory_count: 2 }], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM daily_intelligence_runs") && sql.includes("metadata_json->>'processed' = 'true'")) {
      return { rows: [], rowCount: 0 } as unknown;
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
      const raw = params?.[4];
      if (typeof raw === "string") {
        completionMetadata = JSON.parse(raw) as Record<string, unknown>;
      }
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
      AUTH,
      { skipSdkLifecycle: true }
    );

    assert.equal(result.suggestionCount, 1);
    assert.ok(createdSuggestionId, "suggestion should be created");
    assert.equal(completionMetadata?.firstProcessedRun, true);
    assert.equal(completionMetadata?.processed, true);
    assert.deepEqual(statuses, [
      { channel: "whatsapp", status: "queued" },
      { channel: "whatsapp", status: "sent" },
    ]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

test("daily intelligence aborts loop flow when cleanup fails", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let dailyRunMarkedFailed = false;
  let loopTouched = false;
  const dailyRunId = "55555555-5555-4555-8555-555555555555";

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("loop_miner_runs")) {
      loopTouched = true;
    }
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("WITH lock_key AS") && sql.includes("INSERT INTO daily_intelligence_runs")) {
      return { rows: [{ inserted_id: dailyRunId, existing_id: null }], rowCount: 1 } as unknown;
    }
    if (sql.includes("COUNT(*)::int AS active_memory_count") && sql.includes("FROM memory_records")) {
      return { rows: [{ active_memory_count: 3 }], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM daily_intelligence_runs") && sql.includes("metadata_json->>'processed' = 'true'")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    if (sql.includes("INSERT INTO memory_cleanup_runs")) {
      throw new Error("cleanup insert failed");
    }
    if (sql.includes("UPDATE daily_intelligence_runs")) {
      const raw = params?.[4];
      if (typeof raw === "string") {
        const metadata = JSON.parse(raw) as Record<string, unknown>;
        if (metadata.failureStage === "daily_pipeline") {
          dailyRunMarkedFailed = true;
        }
      }
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    await assert.rejects(
      workflowAutomation.runDailyIntelligencePassForUserInternal(AUTH, { skipSdkLifecycle: true }),
      /cleanup insert failed/
    );
    assert.equal(dailyRunMarkedFailed, true);
    assert.equal(loopTouched, false);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("daily intelligence skips unpaid users before cleanup and loop runs", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let cleanupOrLoopTouched = false;
  let dailyRunUpdated = false;
  const dailyRunId = "22222222-2222-4222-8222-222222222222";

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("memory_cleanup_runs") || sql.includes("loop_miner_runs")) {
      cleanupOrLoopTouched = true;
    }
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "free", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("WITH lock_key AS") && sql.includes("INSERT INTO daily_intelligence_runs")) {
      return { rows: [{ inserted_id: dailyRunId, existing_id: null }], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE daily_intelligence_runs")) {
      dailyRunUpdated = true;
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await workflowAutomation.runDailyIntelligencePassForUserInternal(AUTH, { skipSdkLifecycle: true });
    assert.equal(result.suggestionCount, 0);
    assert.equal(dailyRunUpdated, true);
    assert.equal(cleanupOrLoopTouched, false);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("daily intelligence skips users with no memory records before cleanup and loop runs", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let cleanupOrLoopTouched = false;
  let dailyRunUpdated = false;
  const dailyRunId = "33333333-3333-4333-8333-333333333333";

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("memory_cleanup_runs") || sql.includes("loop_miner_runs")) {
      cleanupOrLoopTouched = true;
    }
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("WITH lock_key AS") && sql.includes("INSERT INTO daily_intelligence_runs")) {
      return { rows: [{ inserted_id: dailyRunId, existing_id: null }], rowCount: 1 } as unknown;
    }
    if (sql.includes("COUNT(*)::int AS active_memory_count") && sql.includes("FROM memory_records")) {
      return { rows: [{ active_memory_count: 0 }], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE daily_intelligence_runs")) {
      dailyRunUpdated = true;
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await workflowAutomation.runDailyIntelligencePassForUserInternal(AUTH, { skipSdkLifecycle: true });
    assert.equal(result.suggestionCount, 0);
    assert.equal(dailyRunUpdated, true);
    assert.equal(cleanupOrLoopTouched, false);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("daily intelligence skips when a run already exists for the current UTC day", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let cleanupOrLoopTouched = false;
  let dailyRunUpdated = false;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("memory_cleanup_runs") || sql.includes("loop_miner_runs")) {
      cleanupOrLoopTouched = true;
    }
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("WITH lock_key AS") && sql.includes("INSERT INTO daily_intelligence_runs")) {
      return {
        rows: [{ inserted_id: null, existing_id: "44444444-4444-4444-8444-444444444444" }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("UPDATE daily_intelligence_runs")) {
      dailyRunUpdated = true;
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await workflowAutomation.runDailyIntelligencePassForUserInternal(AUTH, { skipSdkLifecycle: true });
    assert.equal(result.suggestionCount, 0);
    assert.equal(dailyRunUpdated, false);
    assert.equal(cleanupOrLoopTouched, false);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

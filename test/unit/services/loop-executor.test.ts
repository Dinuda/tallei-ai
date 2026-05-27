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

const [loopExecutor, db] = await Promise.all([
  import("../../../src/services/loop-executor/index.js"),
  import("../../../src/infrastructure/db/index.js"),
]);

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "internal" as const,
  plan: "pro" as const,
};

test("creator builds newsletter loop with CEO and auto-spawned specialists", () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
  });

  assert.equal(definition.definitionVersion, "loop_executor_v1");
  assert.equal(definition.ceo.name, "CEO");
  assert.deepEqual(
    definition.agents.map((agent) => agent.id),
    ["topic_researcher", "creative_writer", "publicist"]
  );
  for (const agent of definition.agents) {
    assert.equal(agent.toolPolicy.allowedTools.length, 1);
    assert.equal(agent.toolPolicy.draftBeforeExternalAction, true);
  }
});

test("executor runs child agents in order and leaves external action as approval draft", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
  });

  const stepNames: string[] = [];
  let finalStatus: string | null = null;
  let finalDraft = "";

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT id, title, status, metadata_json") && sql.includes("FROM workflows")) {
      return {
        rows: [{
          id: "33333333-3333-4333-8333-333333333333",
          title: "Newsletter Loop",
          status: "active",
          metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("INSERT INTO workflow_run_steps")) {
      if (typeof params?.[4] === "string" && typeof params?.[6] === "string") {
        stepNames.push(`${params[4]}:${params[6]}`);
      }
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE workflow_runs") && sql.includes("draft_output")) {
      finalStatus = String(params?.[4]);
      finalDraft = String(params?.[5] ?? "");
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await loopExecutor.executeLoopWorkflow({
      auth,
      workflowId: "33333333-3333-4333-8333-333333333333",
      runMode: "manual",
      scheduledFor: null,
    });

    assert.equal(result.status, "waiting_for_approval");
    assert.equal(result.draftRequired, true);
    assert.equal(finalStatus, "waiting_for_approval");
    assert.match(finalDraft, /Draft approval required/);
    assert.deepEqual(stepNames.filter((name) => name.endsWith(":completed")), [
      "ceo_dispatch:completed",
      "agent:topic_researcher:completed",
      "agent:creative_writer:completed",
      "agent:publicist:completed",
      "ceo_finalize:completed",
    ]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("scheduler claims active due loops, recomputes next run, and dispatches through executor", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalConnect = db.pool.connect.bind(db.pool);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
  });

  let dueQueryCheckedActiveStatus = false;
  let nextRunWritten: string | null = null;
  const fakeClient = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM workflows") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        dueQueryCheckedActiveStatus = sql.includes("status = 'active'");
        return {
          rows: [{
            id: "44444444-4444-4444-8444-444444444444",
            tenant_id: auth.tenantId,
            user_id: auth.userId,
            schedule_rrule: "0 9 * * 1",
            next_run_at: "2026-05-25T09:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE workflows") && params?.[1]) {
        nextRunWritten = String(params[1]);
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      return undefined;
    },
  };

  (db.pool as unknown as { connect: typeof db.pool.connect }).connect = (async () => fakeClient) as typeof db.pool.connect;
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("SELECT id, title, status, metadata_json") && sql.includes("FROM workflows")) {
      return {
        rows: [{
          id: "44444444-4444-4444-8444-444444444444",
          title: "Newsletter Loop",
          status: "active",
          metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await loopExecutor.dispatchDueLoopWorkflows({ limit: 1, source: "internal" });
    assert.equal(result.claimed, 1);
    assert.equal(result.dispatched, 1);
    assert.equal(result.failed, 0);
    assert.equal(dueQueryCheckedActiveStatus, true);
    assert.equal(nextRunWritten, "2026-06-01T09:00:00.000Z");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    (db.pool as unknown as { connect: typeof db.pool.connect }).connect = originalConnect;
  }
});

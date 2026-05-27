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

const [loopExecutor, toolCatalog, db] = await Promise.all([
  import("../../../src/services/loop-executor/index.js"),
  import("../../../src/services/loop-executor/tool-catalog.js"),
  import("../../../src/infrastructure/db/index.js"),
]);
const { aiProviderRegistry } = await import("../../../src/providers/ai/index.js");

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "internal" as const,
  plan: "pro" as const,
};

test("creator builds v2 loop definition without fixed agents", () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  assert.equal(definition.definitionVersion, "loop_executor_v2");
  assert.equal(definition.ceo.name, "CEO");
  assert.ok(Array.isArray(definition.allowedIntegrations));
  assert.equal("agents" in definition, false);
});

test("tool catalog rejects unknown tool refs", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;
  try {
    const result = await toolCatalog.validateToolAssignments({
      tools: [{ ref: "unknown.tool" }],
      definition: { allowedIntegrations: ["internal"], allowedToolRefs: undefined },
      auth,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues[0]?.code, "unknown_tool");
    }
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("tool catalog allows connector warnings without blocking roster edits", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;
  try {
    const result = await toolCatalog.validateToolAssignments({
      tools: [{ ref: "composio.gmail.create_draft" }],
      definition: { allowedIntegrations: ["internal", "composio"], allowedToolRefs: undefined },
      auth,
      strictConnectors: false,
    });
    assert.equal(result.ok, true);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("executor creates a strategy-gated run with proposed roster only", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalChat = aiProviderRegistry.chat.bind(aiProviderRegistry);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  let insertedRunId: string | null = null;
  let insertedTasks = 0;
  let finalStatus: string | null = null;
  let strategyOutput = "";
  let proposedRoster: unknown = null;

  (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = (async () => ({
    text: JSON.stringify({
      strategyText: "CEO strategy: research with memory search, draft with LLM only, prepare Gmail draft.",
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          task: "Gather context",
          tools: [{ ref: "internal.memory_search" }],
        },
        {
          id: "writer",
          name: "Writer",
          task: "Write the draft",
          tools: [{ ref: "internal.llm_only" }],
        },
        {
          id: "publicist",
          name: "Publicist",
          task: "Prepare Gmail draft",
          tools: [{ ref: "composio.gmail.create_draft" }],
        },
      ],
    }),
    model: "gpt-4o-mini",
    finishReason: "stop",
  })) as typeof aiProviderRegistry.chat;

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
    if (sql.includes("INSERT INTO workflow_runs")) {
      insertedRunId = String(params?.[0]);
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM workflow_runs r") && sql.includes("JOIN workflows w")) {
      return {
        rows: [{
          id: insertedRunId,
          tenant_id: auth.tenantId,
          user_id: auth.userId,
          workflow_id: "33333333-3333-4333-8333-333333333333",
          status: "running",
          draft_output: null,
          metadata_json: {},
          workflow_title: "Newsletter Loop",
          workflow_metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("INSERT INTO loop_run_tasks")) {
      insertedTasks += 1;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE workflow_runs") && sql.includes("waiting_for_strategy_approval")) {
      finalStatus = "waiting_for_strategy_approval";
      strategyOutput = String(params?.[3] ?? "");
      const metadata = JSON.parse(String(params?.[4] ?? "{}")) as { loop_executor?: { proposedRoster?: unknown } };
      proposedRoster = metadata.loop_executor?.proposedRoster ?? null;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM connector_accounts")) {
      return { rows: [], rowCount: 0 } as unknown;
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

    assert.equal(result.status, "waiting_for_strategy_approval");
    assert.equal(result.draftRequired, false);
    assert.equal(finalStatus, "waiting_for_strategy_approval");
    assert.match(strategyOutput, /CEO strategy/);
    assert.equal(insertedTasks, 0);
    assert.ok(Array.isArray(proposedRoster));
    assert.equal((proposedRoster as Array<{ id: string }>).length, 3);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = originalChat;
  }
});

test("scheduler claims active due loops, recomputes next run, and dispatches through executor", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalConnect = db.pool.connect.bind(db.pool);
  const originalChat = aiProviderRegistry.chat.bind(aiProviderRegistry);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  let dueQueryCheckedActiveStatus = false;
  let nextRunWritten: string | null = null;
  let insertedRunId: string | null = null;
  (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = (async () => ({
    text: JSON.stringify({
      strategyText: "CEO strategy: ordered plan.",
      agents: [
        { id: "writer", name: "Writer", task: "Write", tools: [{ ref: "internal.llm_only" }] },
      ],
    }),
    model: "gpt-4o-mini",
    finishReason: "stop",
  })) as typeof aiProviderRegistry.chat;
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
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
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
    if (sql.includes("INSERT INTO workflow_runs")) {
      insertedRunId = String(params?.[0]);
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM workflow_runs r") && sql.includes("JOIN workflows w")) {
      return {
        rows: [{
          id: insertedRunId,
          tenant_id: auth.tenantId,
          user_id: auth.userId,
          workflow_id: "44444444-4444-4444-8444-444444444444",
          status: "running",
          draft_output: null,
          metadata_json: {},
          workflow_title: "Newsletter Loop",
          workflow_metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("FROM connector_accounts")) {
      return { rows: [], rowCount: 0 } as unknown;
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
    (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = originalChat;
  }
});

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
process.env.TALLEI_CONNECTORS__COMPOSIO_STRICT_MODE = "true";
process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY = "composio-test-key";
process.env.TALLEI_CONNECTORS__COMPOSIO_BASE_URL = "https://backend.composio.dev";

const [workflowAutomation, db] = await Promise.all([
  import("../../src/services/workflow-automation.js"),
  import("../../src/infrastructure/db/index.js"),
]);

test("approveWorkflowRun fails closed when Composio execute fails in strict mode", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalFetch = globalThis.fetch;

  let attemptedCompleteUpdate = false;
  let attemptedApprovalInsert = false;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM workflow_runs") && sql.includes("WHERE id = $1") && sql.includes("workflow_id = $2")) {
      return {
        rows: [{
          id: String(params?.[0]),
          workflow_id: String(params?.[1]),
          status: "waiting_for_approval",
          run_mode: "manual",
          scheduled_for: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          draft_output: "Draft generated",
          connector_action_status: "pending",
          metadata_json: {},
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("SELECT requires_connector, connector_provider") && sql.includes("FROM workflows")) {
      return {
        rows: [{ requires_connector: true, connector_provider: "composio" }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("FROM connector_accounts") && sql.includes("provider = 'composio'")) {
      return {
        rows: [{ id: "acc_123", provider: "composio", status: "connected" }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("UPDATE workflow_runs") && sql.includes("SET status = 'completed'")) {
      attemptedCompleteUpdate = true;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO approvals") && sql.includes("'workflow_run'")) {
      attemptedApprovalInsert = true;
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/v2/actions/workflow.execute/execute")) {
      return new Response(JSON.stringify({ error: "upstream failure" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      async () => workflowAutomation.approveWorkflowRun({
        auth: {
          tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authMode: "internal",
          plan: "pro",
        },
        workflowId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        channel: "chat",
      }),
      /Composio request failed|Composio action execution failed/
    );

    assert.equal(attemptedCompleteUpdate, false, "run should not be marked completed on connector failure");
    assert.equal(attemptedApprovalInsert, false, "approval event should not be written on connector failure");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

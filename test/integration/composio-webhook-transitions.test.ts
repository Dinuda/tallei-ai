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

const [composioConnectors, db] = await Promise.all([
  import("../../src/services/connectors/composio.js"),
  import("../../src/infrastructure/db/index.js"),
]);

test("composio webhook marks auth session connected and upserts connected account", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let updatedSessionStatus: string | null = null;
  let insertedAccountStatus: string | null = null;
  let insertedExternalAccountId: string | null = null;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT tenant_id, user_id, provider, metadata_json") && sql.includes("FROM connector_auth_sessions")) {
      return {
        rows: [{
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          provider: "composio",
          metadata_json: {},
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("UPDATE connector_auth_sessions")) {
      updatedSessionStatus = String(params?.[1] ?? "");
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO connector_accounts")) {
      insertedExternalAccountId = String(params?.[4] ?? "");
      insertedAccountStatus = String(params?.[5] ?? "");
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await composioConnectors.handleComposioWebhook({
      type: "connected_account.connected",
      data: {
        connectedAccountId: "conn_123",
        status: "connected",
        scopes: ["gmail.send", "gmail.read"],
        metadata: {
          talleiAuthSessionId: "11111111-1111-4111-8111-111111111111",
        },
      },
    });

    assert.deepEqual(result, { ok: true, processed: true });
    assert.equal(updatedSessionStatus, "connected");
    assert.equal(insertedExternalAccountId, "conn_123");
    assert.equal(insertedAccountStatus, "connected");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("composio webhook marks auth session/account revoked", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  let updatedSessionStatus: string | null = null;
  let insertedAccountStatus: string | null = null;
  let insertedExternalAccountId: string | null = null;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT tenant_id, user_id, provider, metadata_json") && sql.includes("FROM connector_auth_sessions")) {
      return {
        rows: [{
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          provider: "composio",
          metadata_json: {},
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("UPDATE connector_auth_sessions")) {
      updatedSessionStatus = String(params?.[1] ?? "");
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO connector_accounts")) {
      insertedExternalAccountId = String(params?.[4] ?? "");
      insertedAccountStatus = String(params?.[5] ?? "");
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await composioConnectors.handleComposioWebhook({
      type: "connected_account.revoked",
      data: {
        id: "conn_revoked_1",
        status: "revoked",
        metadata: {
          talleiAuthSessionId: "22222222-2222-4222-8222-222222222222",
        },
      },
    });

    assert.deepEqual(result, { ok: true, processed: true });
    assert.equal(updatedSessionStatus, "revoked");
    assert.equal(insertedExternalAccountId, "conn_revoked_1");
    assert.equal(insertedAccountStatus, "revoked");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

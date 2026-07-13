import assert from "node:assert/strict";
import test, { after } from "node:test";

import pg from "pg";

const pgAny = pg as unknown as { Pool: typeof pg.Pool };
const originalPool = pgAny.Pool;

after(() => {
  pgAny.Pool = originalPool;
});

test("initDb falls back to the alternate database URL after auth failure", async () => {
  const originalEnv = {
    internalApiSecret: process.env.TALLEI_HTTP__INTERNAL_API_SECRET,
    databaseUrl: process.env.TALLEI_DB__URL,
    databaseUrlFallback: process.env.TALLEI_DB__URL_FALLBACK,
    jwtSecret: process.env.TALLEI_AUTH__JWT_SECRET,
    autoMigrate: process.env.TALLEI_DB__AUTO_MIGRATE_ON_BOOT,
  };

  process.env.TALLEI_HTTP__INTERNAL_API_SECRET = "test-internal-secret";
  process.env.TALLEI_DB__URL = "postgresql://postgres:wrong@localhost:5432/tallei";
  process.env.TALLEI_DB__URL_FALLBACK = "postgresql://tallei:tallei@localhost:5432/tallei";
  process.env.TALLEI_AUTH__JWT_SECRET = "test-jwt-secret";
  process.env.TALLEI_DB__AUTO_MIGRATE_ON_BOOT = "false";

  const queryLog: string[] = [];
  const releasedClients: string[] = [];
  const poolInstances: Array<{ connectionString: string; ended: boolean; connectCount: number }> = [];

  const authError = Object.assign(new Error('password authentication failed for user "postgres"'), {
    code: "28P01",
  });

  class MockPool {
    connectionString: string;
    ended = false;
    connectCount = 0;

    constructor(options: { connectionString: string }) {
      this.connectionString = options.connectionString;
      poolInstances.push(this);
    }

    on() {}

    async connect() {
      this.connectCount += 1;
      if (this.connectionString === "postgresql://postgres:wrong@localhost:5432/tallei") {
        throw authError;
      }

      return {
        query: async (sql: string) => {
          queryLog.push(sql);
          return { rows: [] };
        },
        release: () => {
          releasedClients.push(this.connectionString);
        },
      };
    }

    async end() {
      this.ended = true;
    }

    async query() {
      throw new Error("unexpected direct pool query");
    }
  }

  pgAny.Pool = MockPool as unknown as typeof originalPool;

  try {
    const db = await import("../../../src/infrastructure/db/index.js");
    await db.initDb();

    assert.equal(poolInstances.length, 2);
    assert.equal(poolInstances[0]?.connectionString, "postgresql://postgres:wrong@localhost:5432/tallei");
    assert.equal(poolInstances[0]?.ended, true);
    assert.equal(poolInstances[0]?.connectCount, 1);
    assert.equal(poolInstances[1]?.connectionString, "postgresql://tallei:tallei@localhost:5432/tallei");
    assert.equal(poolInstances[1]?.ended, false);
    assert.equal((db.pool as unknown as { connectionString: string }).connectionString, "postgresql://tallei:tallei@localhost:5432/tallei");
    assert.deepEqual(queryLog, ["SELECT 1"]);
    assert.deepEqual(releasedClients, ["postgresql://tallei:tallei@localhost:5432/tallei"]);
  } finally {
    process.env.TALLEI_HTTP__INTERNAL_API_SECRET = originalEnv.internalApiSecret;
    process.env.TALLEI_DB__URL = originalEnv.databaseUrl;
    process.env.TALLEI_DB__URL_FALLBACK = originalEnv.databaseUrlFallback;
    process.env.TALLEI_AUTH__JWT_SECRET = originalEnv.jwtSecret;
    process.env.TALLEI_DB__AUTO_MIGRATE_ON_BOOT = originalEnv.autoMigrate;
  }
});

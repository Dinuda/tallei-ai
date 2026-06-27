import assert from "node:assert/strict";
import test from "node:test";

import { migrateTriggerChannelsWorkspaceScope } from "../../../src/infrastructure/db/loop-engine-schema.js";

test("migrateTriggerChannelsWorkspaceScope ensures workspace+account unique index", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ exists: true }] };
      }
      return { rows: [] };
    },
  };

  await migrateTriggerChannelsWorkspaceScope(client as never);

  assert.ok(
    queries.some((sql) => sql.includes("uq_trigger_channels_workspace_account_slug")),
    "expected workspace-scoped unique index",
  );
  assert.ok(
    queries.some((sql) => sql.includes("DROP INDEX IF EXISTS uq_trigger_channels_tenant_user_account_slug")),
    "expected cross-workspace index cleanup",
  );
});

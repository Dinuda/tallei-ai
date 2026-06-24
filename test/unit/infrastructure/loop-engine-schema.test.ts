import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyLoopSpecsTable } from "../../../src/infrastructure/db/loop-engine-schema.js";

test("migrateLegacyLoopSpecsTable renames conductor loop_specs when loop_id is absent", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.includes("information_schema.tables")) {
        const name = params?.[0];
        if (name === "loop_specs") return { rows: [{ exists: true }] };
        if (name === "loop_specs_legacy") return { rows: [{ exists: false }] };
      }
      if (sql.includes("information_schema.columns")) {
        const [table, col] = params ?? [];
        if (table === "loop_specs" && col === "loop_id") return { rows: [{ exists: false }] };
        if (table === "loop_specs" && col === "revision") return { rows: [{ exists: false }] };
        if (table === "loop_specs" && col === "tenant_id") return { rows: [{ exists: true }] };
      }
      return { rows: [] };
    },
  };

  await migrateLegacyLoopSpecsTable(client as never);

  assert.ok(
    queries.some((sql) => sql.includes("ALTER TABLE loop_specs RENAME TO loop_specs_legacy")),
    `expected legacy loop_specs rename; got: ${queries.join("\n")}`,
  );
});

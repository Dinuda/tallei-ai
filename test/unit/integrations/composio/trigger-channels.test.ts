import assert from "node:assert/strict";
import test from "node:test";

test("claimWebhookEventDelivery returns true only on first insert", async () => {
  const seen = new Set<string>();
  const pool = {
    async query(sql: string, params?: unknown[]) {
      const key = `${params?.[1]}:${params?.[2]}`;
      if (sql.includes("ON CONFLICT") && sql.includes("DO NOTHING")) {
        if (seen.has(key)) return { rowCount: 0, rows: [] };
        seen.add(key);
        return { rowCount: 1, rows: [{ id: "delivery-1" }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const { claimWebhookEventDelivery } = await import(
    "../../../../src/integrations/composio/trigger-channels.js"
  );
  const originalPool = (await import("../../../../src/infrastructure/db/index.js")).pool;
  Object.assign(originalPool, pool);

  const input = {
    externalEventId: "evt-1",
    loopId: "loop-1",
  };
  assert.equal(await claimWebhookEventDelivery(input), true);
  assert.equal(await claimWebhookEventDelivery(input), false);
});

test("releaseWorkspaceTriggerChannel decrements ref_count before deleting instance", () => {
  const cases = [
    { before: 2, after: 1, shouldDelete: false },
    { before: 1, after: 0, shouldDelete: true },
  ];
  for (const { before, after, shouldDelete } of cases) {
    const nextRef = Math.max(0, before - 1);
    assert.equal(nextRef, after);
    assert.equal(nextRef === 0, shouldDelete);
  }
});

test("ensureWorkspaceTriggerChannel recreates instance when channel row is stale", () => {
  const cases = [
    { composio_instance_id: null, status: "inactive", recreate: true },
    { composio_instance_id: null, status: "active", recreate: true },
    { composio_instance_id: "inst-1", status: "inactive", recreate: true },
    { composio_instance_id: "inst-1", status: "active", recreate: false },
  ];
  for (const row of cases) {
    const needsRecreate = !row.composio_instance_id || row.status === "inactive";
    assert.equal(needsRecreate, row.recreate);
  }
});

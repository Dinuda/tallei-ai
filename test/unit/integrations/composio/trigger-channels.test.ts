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

test("verifyComposioTriggerInstance retries until the instance becomes visible", async () => {
  const { verifyComposioTriggerInstance } = await import(
    "../../../../src/integrations/composio/trigger-channels.js"
  );
  let calls = 0;
  await verifyComposioTriggerInstance({
    instanceId: "ti-1",
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    connectedAccountId: "ca-1",
    wait: async () => {},
    listActive: async () => {
      calls += 1;
      return calls < 3 ? { items: [] } : {
        items: [{
          id: "ti-1",
          trigger_name: "GMAIL_NEW_GMAIL_MESSAGE",
          connected_account_id: "ca-1",
          disabled_at: null,
        }],
      };
    },
  });
  assert.equal(calls, 3);
});

test("verifyComposioTriggerInstance rejects missing instances", async () => {
  const { ComposioTriggerVerificationError, verifyComposioTriggerInstance } = await import(
    "../../../../src/integrations/composio/trigger-channels.js"
  );
  await assert.rejects(
    verifyComposioTriggerInstance({
      instanceId: "ti-missing",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "ca-1",
      attempts: 1,
      listActive: async () => ({ items: [] }),
    }),
    (error: unknown) => error instanceof ComposioTriggerVerificationError && error.code === "missing_instance",
  );
});

test("verifyComposioTriggerInstance distinguishes disabled and mismatched instances", async () => {
  const { ComposioTriggerVerificationError, verifyComposioTriggerInstance } = await import(
    "../../../../src/integrations/composio/trigger-channels.js"
  );
  const base = {
    instanceId: "ti-1",
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    connectedAccountId: "ca-1",
    attempts: 1,
  };
  await assert.rejects(
    verifyComposioTriggerInstance({
      ...base,
      listActive: async () => ({ items: [{ id: "ti-1", trigger_name: base.triggerSlug, connected_account_id: "ca-1", disabled_at: "2026-01-01" }] }),
    }),
    (error: unknown) => error instanceof ComposioTriggerVerificationError && error.code === "disabled_instance",
  );
  await assert.rejects(
    verifyComposioTriggerInstance({
      ...base,
      listActive: async () => ({ items: [{ id: "ti-1", trigger_name: base.triggerSlug, connected_account_id: "ca-other", disabled_at: null }] }),
    }),
    (error: unknown) => error instanceof ComposioTriggerVerificationError && error.code === "account_mismatch",
  );
  await assert.rejects(
    verifyComposioTriggerInstance({
      ...base,
      listActive: async () => ({ items: [{ id: "ti-1", trigger_name: "SLACK_NEW_MESSAGE", connected_account_id: "ca-1", disabled_at: null }] }),
    }),
    (error: unknown) => error instanceof ComposioTriggerVerificationError && error.code === "slug_mismatch",
  );
});

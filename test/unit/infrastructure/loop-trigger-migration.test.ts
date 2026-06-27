import assert from "node:assert/strict";
import test from "node:test";

import { migrateLoopTriggerRegistrationsToChannels } from "../../../src/infrastructure/db/loop-engine-schema.js";

test("migrateLoopTriggerRegistrationsToChannels creates channel and subscription from legacy row", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const channels = new Map<string, { id: string; ref_count: number; composio_instance_id: string | null }>();
  const subscriptions = new Set<string>();
  let channelSeq = 0;

  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });

      if (sql.includes("information_schema.tables")) {
        return { rows: [{ exists: true }] };
      }
      if (sql.includes("FROM loop_trigger_registrations")) {
        return {
          rows: [
            {
              loop_id: "loop-1",
              workspace_id: "ws-1",
              toolkit: "gmail",
              composio_trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
              composio_instance_id: "inst-1",
              status: "active",
            },
          ],
        };
      }
      if (sql.includes("FROM loop_trigger_subscriptions WHERE loop_id")) {
        return { rows: subscriptions.has(String(params?.[0])) ? [{ exists: 1 }] : [] };
      }
      if (sql.includes("FROM workspace_trigger_channels") && sql.includes("composio_instance_id")) {
        const inst = String(params?.[0]);
        for (const ch of channels.values()) {
          if (ch.composio_instance_id === inst) return { rows: [{ id: ch.id }] };
        }
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO workspace_trigger_channels")) {
        const id = `ch-${++channelSeq}`;
        channels.set(id, {
          id,
          ref_count: 0,
          composio_instance_id: String(params?.[4] ?? null),
        });
        return { rows: [{ id }] };
      }
      if (sql.includes("INSERT INTO loop_trigger_subscriptions")) {
        subscriptions.add(String(params?.[0]));
        return { rows: [] };
      }
      if (sql.includes("UPDATE workspace_trigger_channels") && sql.includes("ref_count")) {
        const channelId = String(params?.[0]);
        const ch = channels.get(channelId);
        if (ch) ch.ref_count = subscriptions.size;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  await migrateLoopTriggerRegistrationsToChannels(client as never);

  assert.ok(
    queries.some((q) => q.sql.includes("INSERT INTO loop_trigger_subscriptions")),
    "expected subscription insert",
  );
  assert.ok(
    queries.some((q) => q.sql.includes("INSERT INTO workspace_trigger_channels")),
    "expected channel insert",
  );
});

test("migrateLoopTriggerRegistrationsToChannels skips when legacy table absent", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ exists: false }] };
      }
      return { rows: [] };
    },
  };

  await migrateLoopTriggerRegistrationsToChannels(client as never);
});

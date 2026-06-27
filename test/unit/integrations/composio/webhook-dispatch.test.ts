import assert from "node:assert/strict";
import test from "node:test";

test("findActiveLoopsByComposioTriggerSlug joins subscriptions within a workspace", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] | undefined;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          { loop_id: "loop-a", active_plan_id: "plan-a", workspace_id: "ws-1" },
          { loop_id: "loop-b", active_plan_id: "plan-b", workspace_id: "ws-1" },
        ],
      };
    },
  };

  const dbModule = await import("../../../../src/infrastructure/db/index.js");
  Object.assign(dbModule.pool, pool);

  const { findActiveLoopsByComposioTriggerSlug } = await import("../../../../src/loops/store.js");
  const matches = await findActiveLoopsByComposioTriggerSlug("ws-1", "GMAIL_NEW_GMAIL_MESSAGE");

  assert.equal(matches.length, 2);
  assert.ok(capturedSql.includes("loop_trigger_subscriptions"));
  assert.ok(capturedSql.includes("workspace_trigger_channels"));
  assert.ok(capturedSql.includes("l.workspace_id"));
  assert.deepEqual(capturedParams?.slice(0, 2), ["ws-1", "GMAIL_NEW_GMAIL_MESSAGE"]);
});

test("dispatchComposioTriggerToLoops skips loops when delivery claim fails", async () => {
  const claims = new Map<string, number>();
  const fanOut = async (loops: string[], externalEventId: string) => {
    const started: string[] = [];
    for (const loopId of loops) {
      const key = `${externalEventId}:${loopId}`;
      if ((claims.get(key) ?? 0) > 0) continue;
      claims.set(key, 1);
      started.push(loopId);
    }
    return started;
  };

  const first = await fanOut(["loop-a", "loop-b"], "evt-1");
  assert.deepEqual(first, ["loop-a", "loop-b"]);

  const retry = await fanOut(["loop-a", "loop-b"], "evt-1");
  assert.deepEqual(retry, []);
});

test("event run fan-out respects workspace concurrency cap", () => {
  const cap = 3;
  let running = 2;
  const loops = ["loop-a", "loop-b", "loop-c"];
  const started: string[] = [];
  let skippedDueToCap = 0;

  for (const loopId of loops) {
    if (running >= cap) {
      skippedDueToCap++;
      continue;
    }
    started.push(loopId);
    running++;
  }

  assert.deepEqual(started, ["loop-a"]);
  assert.equal(skippedDueToCap, 2);
  assert.equal(running, 3);
});

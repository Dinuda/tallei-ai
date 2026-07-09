import assert from "node:assert/strict";
import test from "node:test";

test("conductor builder dedupes chat persistence and meta refresh churn", async () => {
  const fs = await import("node:fs/promises");
  const builder = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url),
    "utf8",
  );

  assert.match(builder, /messagesPersistenceRevision/);
  assert.match(builder, /lastSyncedRevisionRef/);
  assert.match(builder, /lastMetaRefreshAtRef/);
  assert.match(builder, /metaRefreshInFlightRef/);
  assert.match(builder, /Still working/);
  assert.match(builder, /debugConductorClientTiming/);
});

test("conductor shared exposes persistence revision for client dedupe", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );

  assert.match(shared, /export function messagesPersistenceRevision/);
  assert.match(shared, /r:streaming/);
});

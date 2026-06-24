import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";

test("getToolkitConnectionStatus returns disconnected when composio not configured", async () => {
  const originalKey = process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY;
  delete process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY;
  const { getToolkitConnectionStatus } = await import("../../../../src/integrations/composio/accounts.js");
  const status = await getToolkitConnectionStatus(
    { userId: "u1", tenantId: "t1", authMode: "oauth", plan: "free", workspaceId: "ws-1" },
    "gmail",
  );
  assert.equal(status.connected, false);
  assert.equal(status.status, "disconnected");
  if (originalKey) process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY = originalKey;
});

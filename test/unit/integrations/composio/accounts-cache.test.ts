import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../../src/domain/auth/index.js";
import {
  invalidateWorkspaceConnectorsCache,
  resetWorkspaceConnectorsCacheForTests,
  withWorkspaceConnectorsCache,
  type WorkspaceConnectorView,
} from "../../../../src/integrations/composio/accounts.js";

process.env.NODE_ENV ??= "test";

const auth: AuthContext = {
  userId: "user-1",
  tenantId: "tenant-1",
  authMode: "oauth",
  plan: "free",
  workspaceId: "ws-1",
};

const sampleConnectors: WorkspaceConnectorView[] = [{
  slug: "gmail",
  name: "Gmail",
  description: "Email",
  logo: "https://logo.example/gmail.png",
  connected: true,
  connectedAccountId: "ca_1",
}];

test("withWorkspaceConnectorsCache reuses loader result within TTL", async () => {
  resetWorkspaceConnectorsCacheForTests();
  let loaderCalls = 0;

  const load = async () => {
    loaderCalls += 1;
    return sampleConnectors;
  };

  const first = await withWorkspaceConnectorsCache(auth, load);
  const second = await withWorkspaceConnectorsCache(auth, load);
  assert.equal(loaderCalls, 1);
  assert.deepEqual(first, sampleConnectors);
  assert.deepEqual(second, sampleConnectors);

  invalidateWorkspaceConnectorsCache(auth);
  const third = await withWorkspaceConnectorsCache(auth, load);
  assert.equal(loaderCalls, 2);
  assert.equal(third[0]?.slug, "gmail");

  resetWorkspaceConnectorsCacheForTests();
});

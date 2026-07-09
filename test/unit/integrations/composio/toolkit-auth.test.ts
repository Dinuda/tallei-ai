import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNoAuthToolkitView,
  isKnownNoAuthToolkitSlug,
  markNoAuthToolkitSlug,
  requiresConnectionFromToolkitRow,
  resetKnownNoAuthToolkitsForTests,
} from "../../../../src/integrations/composio/toolkit-auth.js";

test("requiresConnectionFromToolkitRow treats NO_AUTH-only toolkits as connection-free", () => {
  assert.equal(requiresConnectionFromToolkitRow({
    authConfigDetails: [{ mode: "NO_AUTH" }],
    composioManagedAuthSchemes: [],
  }), false);
  assert.equal(requiresConnectionFromToolkitRow({
    authConfigDetails: [{ mode: "OAUTH2" }],
    composioManagedAuthSchemes: [],
  }), true);
  assert.equal(requiresConnectionFromToolkitRow({
    authConfigDetails: [],
    composioManagedAuthSchemes: ["OAUTH2"],
  }), true);
});

test("applyNoAuthToolkitView marks known no-auth toolkits ready without OAuth", () => {
  resetKnownNoAuthToolkitsForTests();
  markNoAuthToolkitSlug("composio_search");
  assert.equal(isKnownNoAuthToolkitSlug("COMPOSIO_SEARCH"), true);
  const view = applyNoAuthToolkitView({
    slug: "composio_search",
    name: "Composio Search",
    description: "",
    logo: "",
    connected: false,
    connectable: true,
  });
  assert.equal(view.connected, true);
  assert.equal(view.requiresConnection, false);
  assert.equal(view.connectedAccountId, undefined);
});

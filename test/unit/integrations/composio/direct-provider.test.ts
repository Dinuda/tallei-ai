import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectComposioAuthConfigId } from "../../../../src/integrations/composio/accounts.js";
import { selectLatestToolkitVersion } from "../../../../src/integrations/composio/tools.js";

test("selectComposioAuthConfigId selects the only enabled managed config", () => {
  assert.equal(selectComposioAuthConfigId("gmail", [
    { id: "disabled", status: "DISABLED" },
    { id: "enabled", status: "ENABLED" },
  ]), "enabled");
});

test("selectComposioAuthConfigId rejects ambiguous enabled configs", () => {
  assert.throws(
    () => selectComposioAuthConfigId("gmail", [
      { id: "one", status: "ENABLED" },
      { id: "two", status: "ENABLED" },
    ]),
    /found 2/,
  );
});

test("selectLatestToolkitVersion returns a concrete version", () => {
  assert.equal(selectLatestToolkitVersion(["20260701_00", "20260630_00"]), "20260701_00");
  assert.equal(selectLatestToolkitVersion([]), "latest");
});

test("production Composio client has no Tool Router Session calls", async () => {
  const clientSource = await readFile(new URL("../../../../src/integrations/composio/client.ts", import.meta.url), "utf8");
  const integrationIndex = await readFile(new URL("../../../../src/integrations/composio/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(clientSource, /\.create\(userId|\.use\(sessionId/);
  assert.doesNotMatch(integrationIndex, /session\.js|createSession|useSession/);
});

test("connector authorization creates a missing managed auth config", async () => {
  const accountsSource = await readFile(new URL("../../../../src/integrations/composio/accounts.ts", import.meta.url), "utf8");
  assert.match(accountsSource, /authConfigs\.create\(normalized/);
  assert.match(accountsSource, /type: "use_composio_managed_auth"/);
  assert.match(accountsSource, /authConfigResolutionInFlight/);
});

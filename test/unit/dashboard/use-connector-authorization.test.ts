import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectComposioAuthConfigId } from "../../../src/integrations/composio/accounts.js";

test("useConnectorAuthorization hook defines auto-retry and session restore", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/use-connector-authorization.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /export function formatToolkitLabel/);
  assert.match(source, /MAX_OAUTH_RESTARTS = 3/);
  assert.match(source, /VERIFY_POLL_ATTEMPTS = 3/);
  assert.match(source, /VERIFY_TIMEOUT_MS = 10_000/);
  assert.match(source, /PENDING_CONNECTOR_KEY/);
  assert.match(source, /CONNECTOR_RETURN_URL_KEY/);
  assert.match(source, /resumeAfterReturn/);
  assert.match(source, /incrementRetryCount/);
  assert.match(source, /COMPOSIO_NOT_CONFIGURED/);
  assert.match(source, /AUTH_CONFIG_UNAVAILABLE/);
  assert.doesNotMatch(source, /toast\.error/);
});

test("selectComposioAuthConfigId remains compatible with hook fatal messages", () => {
  assert.equal(
    selectComposioAuthConfigId("gmail", [
      { id: "alpha", status: "ENABLED" },
      { id: "beta", status: "ENABLED" },
    ]),
    "alpha",
  );
});

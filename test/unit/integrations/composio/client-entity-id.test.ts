import assert from "node:assert/strict";
import test from "node:test";

import { getComposioEntityId } from "../../../../src/integrations/composio/client.js";
import type { AuthContext } from "../../../../src/domain/auth/index.js";

const baseAuth: AuthContext = {
  userId: "user-1",
  tenantId: "tenant-1",
  authMode: "oauth",
  plan: "free",
};

test("getComposioEntityId uses tenant and user without workspace", () => {
  assert.equal(getComposioEntityId(baseAuth), "tallei:tenant-1:user-1");
});

test("getComposioEntityId appends workspace when present", () => {
  assert.equal(
    getComposioEntityId({ ...baseAuth, workspaceId: "ws-9" }),
    "tallei:tenant-1:user-1:ws-9",
  );
});

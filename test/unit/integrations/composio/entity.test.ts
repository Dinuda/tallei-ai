import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthContextFromEntity, parseComposioEntityId } from "../../../../src/integrations/composio/entity.js";

test("parseComposioEntityId parses workspace-scoped entity", () => {
  const parsed = parseComposioEntityId("tallei:tenant-1:user-1:ws-9");
  assert.deepEqual(parsed, {
    prefix: "tallei",
    tenantId: "tenant-1",
    userId: "user-1",
    workspaceId: "ws-9",
  });
});

test("buildAuthContextFromEntity returns auth context", () => {
  const auth = buildAuthContextFromEntity("tallei:tenant-1:user-1:ws-9");
  assert.equal(auth?.tenantId, "tenant-1");
  assert.equal(auth?.userId, "user-1");
  assert.equal(auth?.workspaceId, "ws-9");
});

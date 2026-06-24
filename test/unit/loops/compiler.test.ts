import assert from "node:assert/strict";
import test from "node:test";

import { resolveBindingAction } from "../../../src/loops/compiler.js";

test("resolveBindingAction uses static map for gmail email.read", async () => {
  const resolved = await resolveBindingAction("gmail", "email.read");
  assert.ok(resolved);
  assert.equal(resolved?.actionSlug, "GMAIL_FETCH_EMAILS");
});

test("resolveBindingAction uses static map for outlook email.read", async () => {
  const resolved = await resolveBindingAction("outlook", "email.read");
  assert.ok(resolved);
  assert.equal(resolved?.actionSlug, "OUTLOOK_LIST_MESSAGES");
});

test("resolveBindingAction returns null for unsupported capability on known toolkit", async () => {
  const resolved = await resolveBindingAction("gmail", "payment.charge");
  assert.equal(resolved, null);
});

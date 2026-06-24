import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolkitSlug } from "../../../../src/integrations/composio/auth.js";
import {
  normalizeComposioAction,
  normalizeComposioToolSearchResponse,
  orderedSearchActionSlugs,
  parseComposioSearchItems,
} from "../../../../src/integrations/composio/tools.js";

test("normalizeToolkitSlug normalizes common aliases", () => {
  assert.equal(normalizeToolkitSlug("google_calendar"), "googlecalendar");
  assert.equal(normalizeToolkitSlug("google-mail"), "gmail");
  assert.equal(normalizeToolkitSlug("resend_email"), "resend");
  assert.equal(normalizeToolkitSlug("GitHub"), "github");
});

test("normalizeComposioToolSearchResponse unwraps common envelopes", () => {
  assert.deepEqual(normalizeComposioToolSearchResponse({ items: [{ slug: "A" }] }), [{ slug: "A" }]);
  assert.deepEqual(normalizeComposioToolSearchResponse({ tools: [{ slug: "B" }] }), [{ slug: "B" }]);
  assert.deepEqual(normalizeComposioToolSearchResponse([{ slug: "C" }]), [{ slug: "C" }]);
});

test("normalizeComposioAction maps sdk and api field names", () => {
  const action = normalizeComposioAction("gmail", {
    slug: "GMAIL_SEND_EMAIL",
    displayName: "Send Email",
    description: "Send an email",
    input_parameters: { type: "object", properties: { to: { type: "string" } } },
    output_parameters: { type: "object", properties: { id: { type: "string" } } },
    version: "20260301_00",
  });
  assert.ok(action);
  assert.equal(action.actionSlug, "GMAIL_SEND_EMAIL");
  assert.equal(action.name, "Send Email");
  assert.equal(action.toolkitVersion, "20260301_00");
  assert.deepEqual(Object.keys(action.inputSchema), ["type", "properties"]);
});

test("normalizeComposioAction skips deprecated tools", () => {
  assert.equal(normalizeComposioAction("gmail", { slug: "OLD", is_deprecated: true }), null);
});

test("orderedSearchActionSlugs preserves primary-before-related order", () => {
  assert.deepEqual(orderedSearchActionSlugs([
    { primaryToolSlugs: ["GMAIL_LIST_MESSAGES"], relatedToolSlugs: ["GMAIL_SEND_EMAIL"] },
    { primaryToolSlugs: ["GMAIL_GET_THREAD"], relatedToolSlugs: [] },
  ]), ["GMAIL_LIST_MESSAGES", "GMAIL_SEND_EMAIL", "GMAIL_GET_THREAD"]);
});

test("parseComposioSearchItems deduplicates toolkit/action pairs", () => {
  const results = parseComposioSearchItems([
    {
      slug: "GMAIL_SEND_EMAIL",
      toolkit: { slug: "gmail", name: "Gmail" },
      description: "Send email",
      input_parameters: { type: "object", properties: {} },
      tags: ["email"],
    },
    {
      slug: "GMAIL_SEND_EMAIL",
      toolkit: { slug: "gmail", name: "Gmail" },
      description: "duplicate",
      input_parameters: { type: "object", properties: {} },
    },
  ], 10);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.actionSlug, "GMAIL_SEND_EMAIL");
  assert.equal(results[0]?.toolkitName, "Gmail");
  assert.deepEqual(results[0]?.tags, ["email"]);
});

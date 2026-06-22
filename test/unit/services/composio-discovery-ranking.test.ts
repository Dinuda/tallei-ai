import assert from "node:assert/strict";
import test from "node:test";

import { buildComposioActionContract } from "../../../src/services/tool-spec/tool-contracts.js";
import {
  buildCapabilityQueries,
  interleaveDiscoveredTools,
  orderedSearchActionSlugs,
} from "../../../src/services/connectors/composio-discovery-ranking.js";
import type { DiscoveredTool } from "../../../src/services/connectors/composio-discovery.js";

test("buildCapabilityQueries prefers explicit per-action queries", () => {
  assert.deepEqual(buildCapabilityQueries({
    prompt: "Handle support inbox",
    capabilityQueries: ["fetch unread support emails", "send customer reply"],
    toolCategories: ["communication"],
  }), ["fetch unread support emails", "send customer reply"]);
});

test("buildCapabilityQueries falls back to tool categories before the full prompt", () => {
  assert.deepEqual(buildCapabilityQueries({
    prompt: "Handle support inbox",
    toolCategories: ["read inbox", "send reply"],
  }), ["Handle support inbox — read inbox", "Handle support inbox — send reply"]);
});

test("orderedSearchActionSlugs preserves primary-before-related search order", () => {
  assert.deepEqual(orderedSearchActionSlugs([
    { primaryToolSlugs: ["GMAIL_LIST_MESSAGES"], relatedToolSlugs: ["GMAIL_SEND_EMAIL"] },
    { primaryToolSlugs: ["GMAIL_GET_THREAD"], relatedToolSlugs: [] },
  ]), ["GMAIL_LIST_MESSAGES", "GMAIL_SEND_EMAIL", "GMAIL_GET_THREAD"]);
});

test("interleaveDiscoveredTools round-robins per-action result sets", () => {
  const entry = (toolkit: string, actionSlug: string, capabilityQuery: string): DiscoveredTool => ({
    contract: buildComposioActionContract({
      toolkit,
      actionSlug,
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
    }),
    connected: false,
    source: "session_search",
    capabilityQueries: [capabilityQuery],
  });

  const merged = interleaveDiscoveredTools([
    [entry("gmail", "GMAIL_LIST_MESSAGES", "fetch unread emails")],
    [entry("gmail", "GMAIL_SEND_EMAIL", "send reply email")],
  ], 2);

  assert.deepEqual(merged.map((tool) => tool.contract.toolRef), [
    "composio.gmail.action.GMAIL_LIST_MESSAGES",
    "composio.gmail.action.GMAIL_SEND_EMAIL",
  ]);
});

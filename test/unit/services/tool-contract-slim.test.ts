import assert from "node:assert/strict";
import test from "node:test";

import {
  isSlimPersistedToolContract,
  mergePersistedToolContractOverrides,
  shouldPersistFullToolContract,
  slimDiscoveredToolContracts,
  slimToolContractForPersistence,
} from "../../../src/services/tool-spec/tool-contracts.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

function composioContract(overrides: Partial<ToolContract> = {}): ToolContract {
  return {
    toolRef: "composio.gmail.action.GMAIL_FETCH_EMAILS",
    provider: "composio",
    name: "Fetch emails",
    description: "A long description that should not be persisted in slim form.",
    skillTags: ["retrieve"],
    effect: "read_external",
    resources: ["gmail"],
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Large nested schema payload" } },
    },
    outputSchema: {
      type: "object",
      properties: { messages: { type: "array", items: { type: "object" } } },
    },
    executionMode: "short_circuit",
    approval: { required: false },
    renderRecommendations: [],
    readiness: {
      toolRef: "composio.gmail.action.GMAIL_FETCH_EMAILS",
      originalInputSchema: { type: "object" },
      effectiveInputSchema: { type: "object" },
      semanticAssertions: [],
      fieldPolicies: {},
      unresolvedRequirements: [],
      sourceHash: "abc",
      generatedBy: "sdk_contract",
      generatedAt: "2026-06-20T00:00:00.000Z",
    },
    planningHints: ["Use pagination when fetching many messages."],
    constraints: { toolkit: "gmail", actionSlug: "GMAIL_FETCH_EMAILS", connected: true, risk: "read" },
    source: "composio_sdk",
    ...overrides,
  };
}

test("slimToolContractForPersistence drops schemas and enrichment for composio_sdk contracts", () => {
  const slim = slimToolContractForPersistence(composioContract());
  assert.equal(slim.toolRef, "composio.gmail.action.GMAIL_FETCH_EMAILS");
  assert.equal("inputSchema" in slim, false);
  assert.equal("outputSchema" in slim, false);
  assert.equal("description" in slim, false);
  assert.equal("readiness" in slim, false);
  assert.equal("planningHints" in slim, false);
  assert.deepEqual(slim.constraints, {
    toolkit: "gmail",
    actionSlug: "GMAIL_FETCH_EMAILS",
    connected: true,
    risk: "read",
  });
  assert.ok(isSlimPersistedToolContract(slim));
});

test("shouldPersistFullToolContract keeps internal and override-source contracts full", () => {
  assert.equal(shouldPersistFullToolContract(composioContract({ provider: "internal", toolRef: "internal.web_search" })), true);
  assert.equal(shouldPersistFullToolContract(composioContract({ source: "reviewed_override" })), true);
  assert.equal(shouldPersistFullToolContract(composioContract({ source: "llm_contract" })), true);
  assert.equal(shouldPersistFullToolContract(composioContract({ toolRef: "composio.gmail.search" })), true);
  assert.equal(shouldPersistFullToolContract(composioContract()), false);
});

test("slimDiscoveredToolContracts preserves approval overrides in slim refs", () => {
  const [slim] = slimDiscoveredToolContracts([
    composioContract({
      approval: {
        required: true,
        reason: "Operator must approve before send.",
        suggestedGate: { type: "approval", approval: { surface: "confirm.send" } },
      },
    }),
  ]);
  assert.deepEqual(slim.approval, {
    required: true,
    reason: "Operator must approve before send.",
    suggestedGate: { type: "approval", approval: { surface: "confirm.send" } },
  });
});

test("mergePersistedToolContractOverrides overlays persisted routing metadata onto catalog contracts", () => {
  const catalog = composioContract({
    approval: { required: false },
    effect: "read_external",
  });
  const merged = mergePersistedToolContractOverrides(catalog, {
    toolRef: catalog.toolRef,
    provider: catalog.provider,
    effect: "write_external",
    approval: { required: true, reason: "Persisted override" },
    constraints: { connected: false },
  });
  assert.equal(merged.effect, "write_external");
  assert.equal(merged.approval.required, true);
  assert.equal(merged.approval.reason, "Persisted override");
  assert.equal(merged.constraints.connected, false);
  assert.ok(Object.keys(merged.inputSchema).length > 0);
});

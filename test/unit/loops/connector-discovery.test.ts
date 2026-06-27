import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConnectorSelectionsToBlueprint,
  applyPrimaryConnectorToBlueprint,
  buildConnectorAskOptions,
  buildConnectorRecommendedIds,
  CONNECTED_TOOLKIT_BOOST,
  inferCatalogToolkitHints,
  resolveAutoConnectorPick,
  TOP_CONNECTOR_RECOMMENDATIONS,
  type ConnectorCandidate,
} from "../../../src/loops/connector-discovery.js";

function candidate(overrides: Partial<ConnectorCandidate> & Pick<ConnectorCandidate, "connector" | "score">): ConnectorCandidate {
  return {
    name: overrides.connector,
    connected: false,
    rationale: "test",
    sampleActions: [],
    ...overrides,
  };
}

test("buildConnectorRecommendedIds returns top five options", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "gmail", score: 10, connected: true, name: "Gmail" }),
    candidate({ connector: "outlook", score: 9, connected: false, name: "Outlook" }),
    candidate({ connector: "zendesk", score: 8, connected: false, name: "Zendesk" }),
    candidate({ connector: "intercom", score: 7, connected: false, name: "Intercom" }),
    candidate({ connector: "freshdesk", score: 6, connected: false, name: "Freshdesk" }),
    candidate({ connector: "slack", score: 5, connected: false, name: "Slack" }),
  ]);
  const ids = buildConnectorRecommendedIds(options);
  assert.equal(ids.length, TOP_CONNECTOR_RECOMMENDATIONS);
  assert.equal(ids[0], "connector-gmail");
});

test("buildConnectorAskOptions uses app name and connection status", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "notion", score: 4, connected: true, name: "Notion" }),
    candidate({ connector: "googledocs", score: 3, connected: false, name: "Google Docs" }),
  ]);
  assert.equal(options[0]?.value, "notion");
  assert.equal(options[0]?.label, "Notion");
  assert.match(options[0]?.description ?? "", /connected/i);
  assert.match(options[1]?.description ?? "", /needs connection/i);
});

test("inferCatalogToolkitHints includes email apps for support outcomes", () => {
  const hints = inferCatalogToolkitHints("incoming support ticket emails", "trigger");
  assert.ok(hints.includes("gmail"));
  assert.ok(hints.includes("outlook") || hints.includes("zendesk"));
});

test("resolveAutoConnectorPick returns sole connected top recommendation", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "gmail", score: 10, connected: true, name: "Gmail" }),
    candidate({ connector: "outlook", score: 9, connected: false, name: "Outlook" }),
  ]);
  const ids = buildConnectorRecommendedIds(options);
  assert.equal(resolveAutoConnectorPick(options, ids), "gmail");
});

test("applyPrimaryConnectorToBlueprint marks all pending outcomes", () => {
  const blueprint = {
    version: 1 as const,
    summary: "Support triage",
    outcomes: [
      { id: "out-1", role: "trigger" as const, description: "On email", candidates: [], status: "pending" as const },
      { id: "out-2", role: "source" as const, description: "Read email", candidates: [], status: "pending" as const },
      { id: "out-3", role: "transform" as const, description: "Draft reply", candidates: [], status: "pending" as const },
    ],
  };
  const merged = applyPrimaryConnectorToBlueprint(blueprint, "gmail");
  assert.equal(merged.outcomes[0]?.selectedConnector, "gmail");
  assert.equal(merged.outcomes[1]?.selectedConnector, "gmail");
  assert.equal(merged.outcomes[2]?.status, "pending");
});

test("applyConnectorSelectionsToBlueprint marks outcomes chosen", () => {
  const blueprint = {
    version: 1 as const,
    summary: "Support triage",
    outcomes: [
      { id: "out-1", role: "trigger" as const, description: "On email", candidates: [], status: "pending" as const },
      { id: "out-2", role: "source" as const, description: "Read email", candidates: [], status: "pending" as const },
    ],
  };
  const merged = applyConnectorSelectionsToBlueprint(blueprint, [
    { outcomeId: "out-1", connector: "gmail" },
    { outcomeId: "out-2", connector: "gmail" },
  ]);
  assert.equal(merged.outcomes[0]?.selectedConnector, "gmail");
  assert.equal(merged.outcomes[0]?.status, "chosen");
  assert.equal(merged.outcomes[1]?.status, "chosen");
});

test("buildConnectorRecommendedIds prefers connected when scores tie in top five", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "gmail", score: 5 + CONNECTED_TOOLKIT_BOOST, connected: true, name: "Gmail" }),
    candidate({ connector: "mailchimp", score: 8, connected: false, name: "Mailchimp" }),
  ]);
  assert.equal(options[0]?.id, "connector-gmail");
  assert.deepEqual(buildConnectorRecommendedIds(options), ["connector-gmail", "connector-mailchimp"]);
});

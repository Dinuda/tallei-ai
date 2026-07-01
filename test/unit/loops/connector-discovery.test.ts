import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConnectorSelectionsToBlueprint,
  applyPrimaryConnectorToBlueprint,
  buildConnectorAskOptions,
  buildConnectorRecommendedIds,
  CONNECTED_TOOLKIT_BOOST,
  discoverConnectorsForBlueprint,
  inferCatalogToolkitHints,
  TOP_CONNECTOR_RECOMMENDATIONS,
  type ConnectorCandidate,
} from "../../../src/loops/connector-discovery.js";
import type { AuthContext } from "../../../src/domain/auth/index.js";
import type { CatalogToolkitView } from "../../../src/integrations/composio/accounts.js";
import type { ComposioToolSearchResult } from "../../../src/integrations/composio/types.js";

const auth: AuthContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};

const toolkits: CatalogToolkitView[] = [
  {
    slug: "gmail",
    name: "Gmail",
    description: "Email",
    logo: "",
    connected: true,
    connectedAccountId: "account-1",
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Team chat",
    logo: "",
    connected: false,
  },
];

function searchResult(overrides: Partial<ComposioToolSearchResult> = {}): ComposioToolSearchResult {
  return {
    toolkit: "gmail",
    toolkitName: "Gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    name: "Send email",
    description: "Send an email message",
    inputSchema: {},
    tags: [],
    ...overrides,
  };
}

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

test("applyPrimaryConnectorToBlueprint marks all pending outcomes", () => {
  const blueprint = {
    version: 1 as const,
    summary: "Support triage",
    outcomes: [
      { id: "out-1", role: "trigger" as const, description: "On email", status: "pending" as const },
      { id: "out-2", role: "source" as const, description: "Read email", status: "pending" as const },
      { id: "out-3", role: "transform" as const, description: "Draft reply", status: "pending" as const },
    ],
  };
  const merged = applyPrimaryConnectorToBlueprint(blueprint, "gmail");
  assert.equal(merged.outcomes[0]?.status, "chosen");
  assert.equal(merged.outcomes[0]?.selectedConnector, "gmail");
  assert.equal(merged.outcomes[1]?.status, "chosen");
  assert.equal(merged.outcomes[2]?.status, "pending");
});

test("applyConnectorSelectionsToBlueprint marks outcomes chosen", () => {
  const blueprint = {
    version: 1 as const,
    summary: "Support triage",
    outcomes: [
      { id: "out-1", role: "trigger" as const, description: "On email", status: "pending" as const },
      { id: "out-2", role: "source" as const, description: "Read email", status: "pending" as const },
    ],
  };
  const merged = applyConnectorSelectionsToBlueprint(blueprint, [
    { outcomeId: "out-1", connector: "gmail" },
    { outcomeId: "out-2", connector: "zendesk" },
  ]);
  assert.equal(merged.outcomes[0]?.status, "chosen");
  assert.equal(merged.outcomes[1]?.status, "chosen");
  assert.equal(merged.outcomes[0]?.selectedConnector, "gmail");
  assert.equal(merged.outcomes[1]?.selectedConnector, "zendesk");
});

test("buildConnectorRecommendedIds prefers connected when scores tie in top five", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "gmail", score: 5 + CONNECTED_TOOLKIT_BOOST, connected: true, name: "Gmail" }),
    candidate({ connector: "mailchimp", score: 8, connected: false, name: "Mailchimp" }),
  ]);
  assert.equal(options[0]?.id, "connector-gmail");
  assert.deepEqual(buildConnectorRecommendedIds(options), ["connector-gmail", "connector-mailchimp"]);
});

test("discoverConnectorsForBlueprint loads toolkits once and deduplicates identical searches", async () => {
  let catalogueCalls = 0;
  const searchQueries: string[] = [];
  const timings: Array<Record<string, number>> = [];

  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "out-1", role: "destination", description: "Send email" },
      { id: "out-2", role: "destination", description: "  SEND   EMAIL " },
    ],
  }, {
    loadToolkits: async () => {
      catalogueCalls += 1;
      return { toolkits, total: toolkits.length };
    },
    searchTools: async (query) => {
      searchQueries.push(query);
      return [searchResult()];
    },
    now: () => 100,
    logTiming: (timing) => timings.push(timing),
  });

  assert.equal(catalogueCalls, 1);
  assert.equal(searchQueries.length, 1);
  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["out-1", "out-2"]);
  assert.equal(result.groups[0]?.askOptions[0]?.value, "gmail");
  assert.equal(result.groups[0]?.askOptions[0]?.description, "Already connected");
  assert.equal(timings[0]?.searchCount, 1);
  assert.equal(timings[0]?.outcomeCount, 2);
});

test("discoverConnectorsForBlueprint starts distinct searches concurrently and preserves outcome order", async () => {
  const resolvers = new Map<string, (results: ComposioToolSearchResult[]) => void>();
  const started: string[] = [];

  const discovery = discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "out-email", role: "destination", description: "Send email" },
      { id: "out-chat", role: "destination", description: "Post to Slack" },
    ],
  }, {
    loadToolkits: async () => ({ toolkits, total: toolkits.length }),
    searchTools: (query) => {
      started.push(query);
      return new Promise((resolve) => resolvers.set(query, resolve));
    },
    logTiming: () => undefined,
  });

  await Promise.resolve();
  assert.equal(started.length, 2);
  resolvers.get(started[1]!)?.([searchResult({
    toolkit: "slack",
    toolkitName: "Slack",
    actionSlug: "SLACK_SEND_MESSAGE",
    name: "Send Slack message",
  })]);
  resolvers.get(started[0]!)?.([searchResult()]);

  const result = await discovery;
  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["out-email", "out-chat"]);
  assert.equal(result.groups[0]?.askOptions[0]?.value, "gmail");
  assert.equal(result.groups[1]?.askOptions[0]?.value, "slack");
});

test("discoverConnectorsForBlueprint skips Composio loading for transform-only blueprints", async () => {
  let calls = 0;
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [{ id: "out-1", role: "transform", description: "Summarize text" }],
  }, {
    loadToolkits: async () => {
      calls += 1;
      return { toolkits: [], total: 0 };
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { groups: [], pickerKind: "app" });
});

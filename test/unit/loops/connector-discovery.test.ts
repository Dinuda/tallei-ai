import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConnectorSelectionsToBlueprint,
  applyPrimaryConnectorToBlueprint,
  buildConnectorAskOptions,
  buildConnectorRecommendedIds,
  connectorQuestionForOutcome,
  discoverConnectorsForBlueprint,
  TOP_CONNECTOR_RECOMMENDATIONS,
  type ConnectorCandidate,
} from "../../../src/loops/connector-discovery.js";
import type { AuthContext } from "../../../src/domain/auth/index.js";
import type { CatalogToolkitView } from "../../../src/integrations/composio/accounts.js";
import type { ComposioToolSearchResult } from "@tallei/composio-tools/types.js";

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
    connectable: true,
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

test("buildConnectorAskOptions keeps unavailable apps visible but not selectable", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "outlook", score: 4, connectable: false, name: "Outlook" }),
  ]);
  assert.equal(options[0]?.disabled, true);
  assert.match(options[0]?.description ?? "", /unavailable/i);
  assert.deepEqual(buildConnectorRecommendedIds(options), []);
});

test("connector questions preserve the actual workflow outcome", () => {
  assert.equal(connectorQuestionForOutcome({
    role: "trigger",
    description: "Detects when a new support ticket is submitted",
  }), "Where should a new support ticket come from?");
  assert.equal(connectorQuestionForOutcome({
    role: "source",
    description: "Retrieves ticket details",
  }), "Where should ticket details come from?");
  assert.equal(connectorQuestionForOutcome({
    role: "trigger",
    description: "Monitors for new incoming support tickets",
  }), "Where should new incoming support tickets come from?");
  assert.equal(connectorQuestionForOutcome({
    role: "destination",
    description: "Publishes the completed result",
  }), "Where should the completed result be delivered?");
  assert.equal(connectorQuestionForOutcome({
    role: "trigger",
    description: "wait for a new support ticket to arrive",
  }), "Where should new support ticket come from?");
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

test("buildConnectorRecommendedIds follows relevance order instead of connection state", () => {
  const options = buildConnectorAskOptions([
    candidate({ connector: "gmail", score: 5, connected: true, name: "Gmail" }),
    candidate({ connector: "mailchimp", score: 8, connected: false, name: "Mailchimp" }),
  ]);
  assert.equal(options[0]?.id, "connector-gmail");
  assert.deepEqual(buildConnectorRecommendedIds(options), ["connector-gmail", "connector-mailchimp"]);
});

test("discoverConnectorsForBlueprint treats connection as a secondary viability boost", async () => {
  const rankedToolkits: CatalogToolkitView[] = [
    { slug: "gmail", name: "Gmail", description: "Email", logo: "", connected: true },
    { slug: "notion", name: "Notion", description: "Knowledge base", logo: "", connected: false },
  ];
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [{ id: "publish", role: "destination", description: "Publish a knowledge base article" }],
  }, {
    loadToolkits: async () => ({ toolkits: rankedToolkits, total: rankedToolkits.length }),
    searchTools: async () => [
      searchResult({
        toolkit: "notion",
        toolkitName: "Notion",
        actionSlug: "NOTION_CREATE_PAGE",
        name: "Create page",
        description: "Create a new knowledge base article",
      }),
    ],
    logTiming: () => undefined,
  });

  assert.equal(result.groups[0]?.recommendedOptionIds[0], "connector-notion");
  assert.ok(result.groups[0]?.recommendedOptionIds.includes("connector-gmail"));
  assert.equal(result.groups[0]?.askOptions[0]?.value, "notion");
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

test("discoverConnectorsForBlueprint returns the full catalog and recommends only the top five", async () => {
  const fullCatalog: CatalogToolkitView[] = [
    ...toolkits,
    ...["outlook", "zendesk", "intercom", "freshdesk", "mailchimp"].map((slug) => ({
      slug,
      name: slug,
      description: "",
      logo: "",
      connected: false,
    })),
  ];
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [{ id: "send", role: "destination", description: "Send an email" }],
  }, {
    loadToolkits: async () => ({ toolkits: fullCatalog, total: fullCatalog.length }),
    searchTools: async () => [searchResult()],
    logTiming: () => undefined,
  });

  assert.equal(result.groups[0]?.askOptions.length, fullCatalog.length);
  assert.equal(result.groups[0]?.recommendedOptionIds.length, TOP_CONNECTOR_RECOMMENDATIONS);
  assert.equal(result.groups[0]?.askOptions[0]?.value, "gmail");
});

test("trigger picker keeps the full catalog visible and selectable", async () => {
  const fullCatalog: CatalogToolkitView[] = [
    ...toolkits,
    { slug: "freshdesk", name: "Freshdesk", description: "Support tickets", logo: "", connected: false },
  ];
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [{ id: "receive", role: "trigger", description: "Detects when a new support ticket is submitted" }],
  }, {
    loadToolkits: async () => ({ toolkits: fullCatalog, total: fullCatalog.length }),
    searchTools: async () => [searchResult({
      actionSlug: "GMAIL_NEW_MESSAGE",
      name: "New support ticket email",
      description: "Receives a new support ticket email",
    })],
    logTiming: () => undefined,
  });

  const options = result.groups[0]?.askOptions ?? [];
  assert.equal(options.length, fullCatalog.length);
  assert.equal(options.find((option) => option.value === "gmail")?.disabled, undefined);
  assert.equal(options.find((option) => option.value === "slack")?.disabled, undefined);
  assert.equal(options.find((option) => option.value === "freshdesk")?.disabled, undefined);
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
  assert.deepEqual(result, { groups: [], autoResolved: [], pickerKind: "app" });
});

test("discoverConnectorsForBlueprint reuses a clearly leading app selected for a preceding outcome", async () => {
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Receive a Gmail message" },
      { id: "read", role: "source", description: "Read the Gmail message" },
    ],
    previousSelections: [{ outcomeId: "receive", role: "trigger", connector: "gmail" }],
  }, {
    loadToolkits: async () => ({ toolkits, total: toolkits.length }),
    searchTools: async () => [searchResult({
      actionSlug: "GMAIL_FETCH_MESSAGE",
      name: "Read Gmail message",
      description: "Read a Gmail email message",
    })],
    loadActions: async () => [searchResult({
      actionSlug: "GMAIL_FETCH_MESSAGE",
      name: "Read Gmail message",
      description: "Read a Gmail email message",
    })],
    loadTriggers: async () => [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message" }],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.autoResolved, [{
    outcomeId: "read",
    role: "source",
    connector: "gmail",
    sourceOutcomeId: "receive",
    sourceRole: "trigger",
    reason: "same app as trigger",
  }]);
});

test("discoverConnectorsForBlueprint verifies the selected trigger app's full action catalogue before asking for its initial read", async () => {
  const outlookToolkits: CatalogToolkitView[] = [
    ...toolkits,
    { slug: "outlook", name: "Outlook", description: "Email", logo: "", connected: true },
  ];
  let loadedActions = 0;
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Detect a new incoming support ticket" },
      { id: "read", role: "source", description: "Retrieve ticket details including customer information and message content" },
    ],
    previousSelections: [{ outcomeId: "receive", role: "trigger", connector: "outlook" }],
  }, {
    loadToolkits: async () => ({ toolkits: outlookToolkits, total: outlookToolkits.length }),
    // The broad search misses Outlook, which is the production failure this
    // regression covers.
    searchTools: async () => [searchResult()],
    loadActions: async () => {
      loadedActions += 1;
      return [searchResult({
        toolkit: "outlook",
        toolkitName: "Outlook",
        actionSlug: "OUTLOOK_GET_EMAIL",
        name: "Get email",
        description: "Retrieve an email message and its content",
      })];
    },
    loadTriggers: async () => [{ slug: "OUTLOOK_NEW_EMAIL", name: "New email" }],
    logTiming: () => undefined,
  });

  assert.equal(loadedActions, 1);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.autoResolved, [{
    outcomeId: "read",
    role: "source",
    connector: "outlook",
    sourceOutcomeId: "receive",
    sourceRole: "trigger",
    reason: "same app as trigger",
  }]);
});

test("discoverConnectorsForBlueprint asks separately when the selected trigger app has no read action", async () => {
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Detect a new support event" },
      { id: "read", role: "source", description: "Retrieve the full support record" },
    ],
    previousSelections: [{ outcomeId: "receive", role: "trigger", connector: "slack" }],
  }, {
    loadToolkits: async () => ({ toolkits, total: toolkits.length }),
    searchTools: async () => [searchResult()],
    loadActions: async () => [searchResult({
      toolkit: "slack",
      toolkitName: "Slack",
      actionSlug: "SLACK_SEND_MESSAGE",
      name: "Send message",
      description: "Send a channel message",
    })],
    loadTriggers: async () => [{ slug: "SLACK_RECEIVE_MESSAGE", name: "New message" }],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.autoResolved, []);
  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["read"]);
});

test("discoverConnectorsForBlueprint rejects a selected app that exposes no event triggers", async () => {
  const catalog: CatalogToolkitView[] = [
    ...toolkits,
    { slug: "notion", name: "Notion", description: "Docs", logo: "", connected: true },
  ];
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [{ id: "receive", role: "trigger", description: "Detect a new support ticket" }],
    previousSelections: [{ outcomeId: "receive", role: "trigger", connector: "notion" }],
  }, {
    loadToolkits: async () => ({ toolkits: catalog, total: catalog.length }),
    searchTools: async () => [searchResult()],
    loadTriggers: async () => [],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["receive"]);
  assert.deepEqual(result.rejectedSelections, [{
    outcomeId: "receive",
    role: "trigger",
    connector: "notion",
    reason: "This app does not expose an event matching the requested trigger",
  }]);
});

test("discoverConnectorsForBlueprint defers the initial read until the trigger app is selected", async () => {
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Receive a support email" },
      { id: "read", role: "source", description: "Read the support email details" },
      { id: "draft", role: "transform", description: "Draft a reply" },
      { id: "send", role: "destination", description: "Send the reply" },
    ],
  }, {
    loadToolkits: async () => ({ toolkits, total: toolkits.length }),
    searchTools: async () => [searchResult()],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["receive", "send"]);
  assert.deepEqual(result.groups[0]?.linkedOutcomeIds, []);
});

test("discoverConnectorsForBlueprint does not evaluate source apps before trigger selection", async () => {
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Receive a support event" },
      { id: "read", role: "source", description: "Read the full support record" },
    ],
  }, {
    loadToolkits: async () => ({ toolkits, total: toolkits.length }),
    searchTools: async (query) => query.includes("read fetch") ? [] : [searchResult()],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["receive"]);
  assert.deepEqual(result.groups[0]?.linkedOutcomeIds, []);
});

test("discoverConnectorsForBlueprint does not reuse an app without catalog relevance", async () => {
  const tiedToolkits: CatalogToolkitView[] = [
    ...toolkits,
    { slug: "outlook", name: "Outlook", description: "Email", logo: "", connected: true },
  ];
  const result = await discoverConnectorsForBlueprint(auth, {
    outcomes: [
      { id: "receive", role: "trigger", description: "Receives support tickets" },
      { id: "reply", role: "destination", description: "Sends reply to customer" },
    ],
    previousSelections: [{ outcomeId: "receive", role: "trigger", connector: "gmail" }],
  }, {
    loadToolkits: async () => ({ toolkits: tiedToolkits, total: tiedToolkits.length }),
    searchTools: async () => [
      searchResult(),
      searchResult({
        toolkit: "outlook",
        toolkitName: "Outlook",
        actionSlug: "OUTLOOK_SEND_EMAIL",
        name: "Send email",
      }),
    ],
    loadTriggers: async () => [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message" }],
    logTiming: () => undefined,
  });

  assert.deepEqual(result.groups.map((group) => group.outcomeId), ["reply"]);
  assert.deepEqual(result.autoResolved, []);
});

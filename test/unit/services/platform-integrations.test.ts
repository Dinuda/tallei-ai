import assert from "node:assert/strict";
import test from "node:test";

import {
  composioConnectorContracts,
  isPlatformManagedToolkit,
  mergeToolkitCatalog,
  normalizeDiscoveredToolContracts,
  partitionSelectedToolkits,
  platformManagedToolContracts,
} from "../../../src/services/connectors/platform-integrations.js";

test("exa is treated as a platform-managed internal integration", () => {
  assert.equal(isPlatformManagedToolkit("exa"), true);
  assert.equal(isPlatformManagedToolkit("gmail"), false);

  const { composioToolkits, platformManagedToolkits } = partitionSelectedToolkits(["exa", "gmail", "EXA"]);
  assert.deepEqual(platformManagedToolkits, ["exa", "exa"]);
  assert.deepEqual(composioToolkits, ["gmail"]);

  const contracts = platformManagedToolContracts(["exa"]);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.toolRef, "internal.web_search");
  assert.equal(contracts[0]?.provider, "internal");
});

test("normalizeDiscoveredToolContracts swaps composio exa for internal web search", () => {
  const contracts = normalizeDiscoveredToolContracts([
    {
      toolRef: "composio.exa.action.EXA_SEARCH",
      provider: "composio",
      name: "Exa Search",
      description: "Search",
      skillTags: [],
      effect: "read_external",
      resources: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionMode: "direct",
      approval: { required: false },
      renderRecommendations: [],
      constraints: { toolkit: "exa", actionSlug: "EXA_SEARCH" },
      source: "composio_sdk",
    },
  ]);
  assert.equal(contracts.some((contract) => contract.toolRef === "internal.web_search"), true);
  assert.equal(contracts.some((contract) => contract.provider === "composio"), false);
});

test("composioConnectorContracts excludes platform-managed toolkits", () => {
  const contracts = composioConnectorContracts([
    {
      toolRef: "composio.gmail.action.GMAIL_SEND_EMAIL",
      provider: "composio",
      name: "Send",
      description: "Send",
      skillTags: [],
      effect: "write_external",
      resources: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionMode: "direct",
      approval: { required: true },
      renderRecommendations: [],
      constraints: { toolkit: "gmail", actionSlug: "GMAIL_SEND_EMAIL" },
      source: "composio_sdk",
    },
    {
      toolRef: "composio.exa.action.EXA_SEARCH",
      provider: "composio",
      name: "Exa Search",
      description: "Search",
      skillTags: [],
      effect: "read_external",
      resources: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionMode: "direct",
      approval: { required: false },
      renderRecommendations: [],
      constraints: { toolkit: "exa", actionSlug: "EXA_SEARCH" },
      source: "composio_sdk",
    },
  ]);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.toolRef, "composio.gmail.action.GMAIL_SEND_EMAIL");
});

test("platform-managed apps replace duplicate Composio catalogue entries", () => {
  const merged = mergeToolkitCatalog([
    { slug: "exa", name: "Exa (Composio)", description: "oauth", logo: "" },
    { slug: "gmail", name: "Gmail", description: "email", logo: "" },
  ]);
  assert.equal(merged.filter((entry) => entry.slug === "exa").length, 1);
  assert.equal(merged.find((entry) => entry.slug === "exa")?.name, "Exa");
  assert.ok("platformManaged" in (merged.find((entry) => entry.slug === "exa") ?? {}));
  assert.equal(merged.some((entry) => entry.slug === "gmail"), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  displayNameFromSeed,
  inferActionLabelsFromToolRefs,
  resolveAgentRole,
  slugifyAgentId,
} from "../../../src/services/conductor/services/personas/agent-personas.js";

test("displayNameFromSeed is deterministic for the same seed", () => {
  const seed = "11111111-1111-4111-8111-111111111111";
  assert.equal(displayNameFromSeed(seed), displayNameFromSeed(seed));
});

test("resolveAgentRole maps research-heavy agents to researcher", () => {
  const role = resolveAgentRole("Research Agent", "Search memory and monitor support tickets.");
  assert.equal(role.roleKey, "researcher");
});

test("resolveAgentRole maps marketing agents to marketer", () => {
  const role = resolveAgentRole("Campaign Agent", "Craft audience-facing campaign messaging.");
  assert.equal(role.roleKey, "marketer");
});

test("resolveAgentRole falls back to generalist", () => {
  const role = resolveAgentRole("Helper", "Complete the assigned outcome.");
  assert.equal(role.roleKey, "generalist");
});

test("slugifyAgentId produces stable ids", () => {
  assert.equal(slugifyAgentId("Research Agent", 0), "research_agent");
});

test("inferActionLabelsFromToolRefs maps internal tools to labels", () => {
  const labels = inferActionLabelsFromToolRefs(["internal.memory_search", "internal.web_search"]);
  assert.ok(labels.includes("Searching memory"));
  assert.ok(labels.includes("Searching the web"));
});

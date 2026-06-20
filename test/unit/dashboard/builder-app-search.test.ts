import assert from "node:assert/strict";
import test from "node:test";

import { filterAndRankToolkitSearch, scoreToolkitRelevance } from "../../../src/services/loop-builder/app-search-ranking.js";

const toolkits = [
  {
    slug: "gmail",
    name: "Gmail",
    description: "Gmail is Google's email service",
  },
  {
    slug: "googlesuper",
    name: "Google Super",
    description: "Combines Google services including Drive, Calendar, Gmail, Sheets",
  },
  {
    slug: "mixmax",
    name: "Mixmax",
    description: "Sales engagement platform for Gmail",
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Team messaging",
  },
];

test("app search ranks exact and prefix name matches ahead of description-only matches", () => {
  const ranked = filterAndRankToolkitSearch(toolkits, "gmai", ["gmail"]);
  assert.deepEqual(ranked.map((toolkit) => toolkit.slug), ["gmail"]);
});

test("app search hides description-only matches when a strong name match exists", () => {
  const ranked = filterAndRankToolkitSearch(toolkits, "gmail", []);
  assert.deepEqual(ranked.map((toolkit) => toolkit.slug), ["gmail"]);
  assert.equal(ranked.some((toolkit) => toolkit.slug === "mixmax"), false);
});

test("app search keeps recommended apps first when query is empty", () => {
  const ranked = filterAndRankToolkitSearch(toolkits, "", ["slack", "gmail"]);
  assert.deepEqual(ranked.slice(0, 2).map((toolkit) => toolkit.slug), ["slack", "gmail"]);
});

test("recommended slug boosts relevance within the same match tier", () => {
  const gmailScore = scoreToolkitRelevance(toolkits[0]!, "mail", ["gmail"]);
  const slackScore = scoreToolkitRelevance(toolkits[3]!, "mail", ["gmail"]);
  assert.ok(gmailScore > slackScore);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ActivationSummaryCard renders table, preferences, and transcript block", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/activation-summary-card.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-transcript-block/);
  assert.match(source, /What happens/);
  assert.match(source, /Your preferences/);
  assert.match(source, /<AgentTeamAvatar/);
  assert.match(source, /viewModel\.monitoringNote/);
});

test("activateLoop success renders ActivationSummaryCard in conductor tool part", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /toolName === "activateLoop"/);
  assert.match(source, /<ActivationSummaryCard/);
  assert.match(source, /buildActivationSummaryViewModel/);
});

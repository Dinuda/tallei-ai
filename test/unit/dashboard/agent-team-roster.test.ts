import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("AgentTeamAvatar memoizes Dylan DiceBear generation", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/agent-team-avatar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /@dicebear\/core/);
  assert.match(source, /@dicebear\/dylan/);
  assert.match(source, /useMemo/);
  assert.match(source, /toDataUri/);
  assert.match(source, /rosterAvatarShellClassName/);
  assert.match(source, /38bdf8/);
});

test("AgentTeamRoster uses workflow accordion with OutcomeBriefCard instead of action chips", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/agent-team-roster.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /buildSpecialistWorkflowViewModel/);
  assert.match(source, /<OutcomeBriefCard/);
  assert.match(source, /<AccordionTrigger/);
  assert.match(source, /Workflow/);
  assert.doesNotMatch(source, /ActionChip/);
  assert.doesNotMatch(source, /specialistShowsActionChips/);
});

test("AgentTeamRoster interleaves reviewer using model-provided insert index", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/agent-team-roster.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /reviewerInsertIndex/);
  assert.match(source, /specialistsBeforeReviewer/);
  assert.match(source, /specialistsAfterReviewer/);
  assert.match(source, /TriggerLabRow/);
  assert.match(source, /team\.triggers/);
  assert.match(source, /ConnectorBadge/);
  assert.match(source, /logos\.composio\.dev/);
});

test("presentAgentTeam renders roster output in conductor tool part", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /toolName === "presentAgentTeam"/);
  assert.match(source, /<AgentTeamRoster/);
  assert.match(source, /<AgentTeamRosterPlaceholder/);
});

test("confirmOutcomeBrief skips card unless legacy summary is present", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /input\?\.summary/);
  assert.match(source, /New flow: roster comes from presentAgentTeam/);
  assert.match(source, /return null/);
});

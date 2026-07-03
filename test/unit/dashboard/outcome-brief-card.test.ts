import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("OutcomeBriefCard only renders footer for explicit statuses", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/outcome-brief-card.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /status\?: "pending" \| "confirmed" \| "change-requested"/);
  assert.match(source, /streaming \|\| status === "confirmed" \|\| status === "change-requested"/);
  assert.match(source, /status === "confirmed"\s*\?\s*"Route confirmed"/);
  assert.doesNotMatch(source, /streaming \|\| status \?/);
});

test("confirmOutcomeBrief maps unanswered prompts to pending status for legacy summaries", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /resolveOutcomeBriefCardStatus/);
  assert.match(source, /awaitingInput: part\.state === "input-available"/);
});

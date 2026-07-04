import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDUCTOR_CONTINUE_SUGGESTIONS,
  CONDUCTOR_STALL_QUESTION,
} from "../../../shared/conductor-turn-budget.js";

test("deriveConductorPromptSuggestions returns continue chips when stalled", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(input\.isStalled\)/);
  assert.match(source, /CONDUCTOR_CONTINUE_SUGGESTIONS/);
  assert.deepEqual(
    CONDUCTOR_CONTINUE_SUGGESTIONS.map((suggestion) => suggestion.id),
    ["continue", "okay"],
  );
});

test("deriveConductorPromptSuggestionsQuestion uses stall copy when stalled", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(isStalled\) return CONDUCTOR_STALL_QUESTION/);
  assert.equal(CONDUCTOR_STALL_QUESTION, "I paused mid-setup. Continue when you're ready.");
});

import assert from "node:assert/strict";
import test from "node:test";

test("deriveConductorPromptSuggestions returns contextual recovery actions when budget exhausted", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(input\.budgetExhausted\)/);
  assert.match(source, /isBuildTerminalForStall/);
  assert.doesNotMatch(source, /CONDUCTOR_CONTINUE_SUGGESTIONS/);
  assert.doesNotMatch(source, /isStalled/);
  assert.match(source, /retry-compile/);
  assert.match(source, /revise-bindings/);
});

test("deriveConductorPromptSuggestionsQuestion uses budget-exhausted copy", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(budgetExhausted\) return CONDUCTOR_BUDGET_EXHAUSTED_QUESTION/);
  assert.doesNotMatch(source, /CONDUCTOR_STALL_QUESTION/);
  assert.doesNotMatch(source, /isStalled/);
});

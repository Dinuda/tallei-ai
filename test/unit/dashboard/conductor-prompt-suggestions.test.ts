import assert from "node:assert/strict";
import test from "node:test";

test("deriveConductorPromptSuggestions returns contextual recovery actions when stalled", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(input\.isStalled \|\| input\.budgetExhausted\)/);
  assert.match(source, /isBuildTerminalForStall/);
  assert.doesNotMatch(source, /CONDUCTOR_CONTINUE_SUGGESTIONS/);
  assert.match(source, /retry-compile/);
  assert.match(source, /revise-bindings/);
});

test("deriveConductorPromptSuggestionsQuestion uses contextual recovery copy when stalled", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(isStalled\) return "How should I recover this setup step\?"/);
  assert.doesNotMatch(source, /CONDUCTOR_STALL_QUESTION/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { pickUniqueDisplayName } from "../../../src/services/loop-builder/agent-personas.js";

test("pickUniqueDisplayName avoids duplicate display names in one roster", () => {
  const used = new Set<string>();
  const names = [
    pickUniqueDisplayName("seed-a", 0, used),
    pickUniqueDisplayName("seed-b", 1, used),
    pickUniqueDisplayName("seed-c", 2, used),
  ];
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
});

test("pickUniqueDisplayName respects names already assigned to prior agents", () => {
  const used = new Set<string>(["River"]);
  const next = pickUniqueDisplayName("seed-that-maps-to-river", 0, used);
  assert.notEqual(next, "River");
});

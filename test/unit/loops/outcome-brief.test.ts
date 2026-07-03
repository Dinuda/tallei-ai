import assert from "node:assert/strict";
import test from "node:test";

import {
  computeOutcomeBriefHash,
  isOutcomeBriefConfirmed,
} from "../../../src/loops/outcome-brief.js";
import { applySpecPatch } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("outcome confirmation requires the current spec hash", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.taskBlueprint = {
    version: 1,
    summary: "Support",
    outcomes: [
      { id: "source", role: "source", description: "Read tickets", selectedConnector: "zendesk", status: "chosen" },
      { id: "destination", role: "destination", description: "Notify support", selectedConnector: "slack", status: "chosen" },
    ],
  };
  const confirmed = applySpecPatch(spec, {
    intentDiscovery: { status: "confirmed", confirmedBriefHash: computeOutcomeBriefHash(spec) },
  });
  assert.equal(isOutcomeBriefConfirmed(confirmed), true);

  const edited = applySpecPatch(confirmed, { intent: { outcome: "A changed outcome" } });
  assert.equal(isOutcomeBriefConfirmed(edited), false);
  assert.equal(edited.intentDiscovery.confirmedBriefHash, undefined);
});

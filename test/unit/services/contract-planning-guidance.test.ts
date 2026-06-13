import assert from "node:assert/strict";
import test from "node:test";

import { compactPlannerContracts } from "../../../src/services/loop-engine/architect.js";
import { planningHintsForContract } from "../../../src/services/tool-spec/contract-planning-guidance.js";
import { buildComposioActionContract } from "../../../src/services/tool-spec/tool-contracts.js";

test("connector planning hints are derived from the exact schema without action-specific mappings", () => {
  const contract = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: {
      type: "object",
      properties: {
        recipient_email: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        bcc: { type: "array", items: { type: "string" } },
      },
      required: ["recipient_email", "subject", "body"],
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const hints = planningHintsForContract(contract);
  assert.match(hints.join(" "), /\/subject and \/body/i);
  assert.match(hints.join(" "), /\/bcc/i);
  assert.doesNotMatch(hints.join(" "), /direct send/i);
});

test("compact planner contracts expose planningHints from loaded contracts", () => {
  const contract = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: {
      type: "object",
      properties: {
        recipient_email: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient_email", "subject", "body"],
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const [view] = compactPlannerContracts([contract]);
  assert.ok(Array.isArray(view?.planningHints));
  assert.ok((view?.planningHints?.length ?? 0) > 0);
});

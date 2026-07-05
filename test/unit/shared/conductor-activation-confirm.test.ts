import assert from "node:assert/strict";
import test from "node:test";

import {
  findActivationReplyOption,
  isActivationConfirmationReply,
} from "../../../shared/conductor-activation-confirm.js";

test("isActivationConfirmationReply accepts presentReplyOptions selectedOptionId and message", () => {
  assert.equal(isActivationConfirmationReply(
    { selectedOptionId: "activate", message: "Activate Automation" },
    { options: [{ id: "activate", label: "Activate Automation", message: "Activate Automation" }] },
  ), true);
  assert.equal(isActivationConfirmationReply(
    { selectedOptionId: "custom", message: "Yes, activate the loop." },
    { options: [{ id: "custom", label: "Yes", message: "Yes, activate the loop." }] },
  ), true);
});

test("isActivationConfirmationReply accepts legacy selectedValues", () => {
  assert.equal(isActivationConfirmationReply({ selectedValues: ["confirm"] }), true);
  assert.equal(isActivationConfirmationReply({ selectedValues: ["activate"] }), true);
});

test("isActivationConfirmationReply rejects decline replies", () => {
  assert.equal(isActivationConfirmationReply(
    { selectedOptionId: "hold", message: "Hold activation for now" },
    { options: [{ id: "hold", label: "Hold", message: "Hold activation for now" }] },
  ), false);
  assert.equal(isActivationConfirmationReply(
    { selectedOptionId: "change", message: "Make a change first" },
    { options: [{ id: "change", label: "Change", message: "Make a change first" }] },
  ), false);
});

test("findActivationReplyOption prefers activate-like options", () => {
  const option = findActivationReplyOption({
    options: [
      { id: "hold", label: "Hold", message: "Hold for now" },
      { id: "activate", label: "Activate Automation", message: "Activate Automation" },
    ],
  });
  assert.equal(option?.id, "activate");
});

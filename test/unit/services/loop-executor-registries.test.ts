import assert from "node:assert/strict";
import test from "node:test";

import {
  getDeliveryFormatter,
  plainDeliveryFormatter,
  registerDeliveryFormatter,
  resolveDeliveryFormatter,
} from "../../../src/services/loop-executor/delivery-format.js";
import {
  getExternalActionHandler,
  registerExternalActionHandler,
} from "../../../src/services/loop-executor/external-action-handlers.js";
import {
  getInputGateHandler,
  registerInputGateHandler,
} from "../../../src/services/loop-executor/input-gate-handlers.js";
import {
  getToolHandler,
  registerToolHandler,
} from "../../../src/services/loop-executor/tool-handlers.js";
import {
  loopDefinitionSchema,
  loopExternalActionStageSchema,
  type DeliveryContentFormatter,
  type LoopDefinition,
} from "../../../src/services/loop-executor/types.js";

const baseDefinition: LoopDefinition = loopDefinitionSchema.parse({
  definitionVersion: "loop_executor_v2",
  goal: "Create a weekly blog post from recent product notes.",
  schedule: { cron: "0 9 * * 1", timezone: "UTC" },
  allowedIntegrations: ["internal"],
  ceo: {
    name: "Parent Agent",
    task: "Coordinate the loop.",
    policy: "Use the configured loop plan.",
  },
  draftPolicy: {
    requireDraftBeforeExternalAction: true,
    approvalRequiredFor: ["external_action"],
  },
});

test("tool dispatch registry resolves registered handlers and fails closed for unknown refs", async () => {
  const ref = "test.registry_tool";
  registerToolHandler(ref, async () => ({ text: "handled" }));

  assert.deepEqual(await getToolHandler(ref)?.({} as never), { text: "handled" });
  assert.equal(getToolHandler("test.missing_tool"), undefined);
});

test("input gate registry resolves handlers by structured gate kind", async () => {
  registerInputGateHandler("test_input", ({ value }) => ({
    body: value.trim(),
    data: { value: value.trim() },
  }));

  const handler = getInputGateHandler("test_input");
  assert.ok(handler);
  assert.deepEqual(await handler({ value: "  approved  ", stage: {} as never }), {
    body: "approved",
    data: { value: "approved" },
  });
  assert.equal(getInputGateHandler("unknown_input"), undefined);
});

test("external action registry resolves explicit handlers and has no default fallback", () => {
  registerExternalActionHandler("test.external_action", async () => ({ status: "queued" }));

  assert.ok(getExternalActionHandler("test.external_action"));
  assert.equal(getExternalActionHandler("internal.resend_broadcast_missing"), undefined);
});

test("delivery formatter registry prefers schema-backed delivery type and falls back to plain text", () => {
  const formatter: DeliveryContentFormatter = {
    sanitizeBody: (raw) => `custom:${raw}`,
    formatForDelivery: (raw) => ({ subject: "Custom", text: raw, html: `<p>${raw}</p>` }),
    formatForBroadcast: (formatted) => ({ text: formatted.text, html: formatted.html }),
  };
  registerDeliveryFormatter("test_delivery", formatter);

  assert.equal(getDeliveryFormatter("test_delivery"), formatter);
  assert.equal(resolveDeliveryFormatter({ ...baseDefinition, deliveryType: "test_delivery" }), formatter);
  assert.equal(resolveDeliveryFormatter(baseDefinition), plainDeliveryFormatter);
});

test("external action stages default to approval before execution", () => {
  const stage = loopExternalActionStageSchema.parse({
    kind: "external_action",
    id: "publish",
    label: "Publish",
    toolRef: "test.external_action",
  });

  assert.deepEqual(stage.approvalPolicy, {
    required: true,
    mode: "before",
    channels: ["primary"],
    onReject: "block",
  });
});

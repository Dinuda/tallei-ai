import assert from "node:assert/strict";
import test from "node:test";

import { normalizeComposioExecutionResult } from "../../../src/services/connectors/composio.js";
import { validateConnectorActionPayload } from "../../../src/services/loop-runtime/connector-action-payload.js";
import { resolveAgentHandoffBindings } from "../../../src/services/loop-runtime/typed-handoff.js";
import { buildConnectorActionReadinessContract, validateConnectorReadiness } from "../../../src/services/tool-spec/action-readiness.js";

test("connector action payload validation uses the exact action schema", () => {
  const contract = {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { recipient_email: { type: "string", format: "email" }, subject: { type: "string" } },
      required: ["recipient_email", "subject"],
    },
  };
  assert.equal(validateConnectorActionPayload(contract, { recipients: ["person@example.com"], subject: "Hello" }).valid, false);
  assert.equal(validateConnectorActionPayload(contract, { recipient_email: "person@example.com", subject: "Hello" }).valid, true);
});

test("SDK readiness preserves exact schema without prose or field-name inference", () => {
  const inputSchema = {
    type: "object",
    properties: { recipient: { type: "string", description: "Primary recipient email address." } },
    required: ["recipient"],
  };
  const readiness = buildConnectorActionReadinessContract({ toolRef: "composio.example.action.send", inputSchema });
  assert.deepEqual(readiness.effectiveInputSchema, inputSchema);
  assert.deepEqual(readiness.fieldPolicies, {});
  assert.equal(validateConnectorReadiness(readiness, { recipient: "{{runtime.recipients}}" }).valid, false);
});

test("Composio unsuccessful envelopes are normalized as failures", () => {
  assert.deepEqual(normalizeComposioExecutionResult({
    adapter: "composio-sdk",
    result: { successful: false, error: "Invalid request data", logId: "log_123" },
  }), { ok: false, error: "Invalid request data", providerLogId: "log_123" });
});

test("connector payload resolves only from declared handoff bindings", () => {
  const resolved = resolveAgentHandoffBindings({
    agent: {
      handoffBindings: [{
        source: { kind: "agent_output", agentId: "writer", path: "/body" },
        targetPath: "/body",
        required: true,
      }],
    },
    priorOutputs: { writer_output: { structuredOutput: { body: "Update" } } },
    operatorInputs: {},
  });
  assert.deepEqual(resolved.value, { body: "Update" });
});

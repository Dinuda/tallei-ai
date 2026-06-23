import assert from "node:assert/strict";
import test from "node:test";

import { resolveConnectorOutputForValidation, sanitizeComposioProviderOutput, validateConnectorActionOutput } from "../../../src/services/conductor/runtime/connector-action-payload.js";
import { buildComposioActionContract } from "../../../src/services/tool-spec/tool-contracts.js";

const gmailSendOutputSchema = {
  type: "object",
  required: ["data", "successful"],
  properties: {
    data: {
      type: "object",
      properties: {
        id: { type: "string" },
        threadId: { type: "string" },
      },
    },
    error: { type: "string" },
    successful: { type: "boolean" },
  },
};

test("resolveConnectorOutputForValidation unwraps composio sdk envelopes", () => {
  const inner = { id: "msg123", threadId: "t1" };
  const resolved = resolveConnectorOutputForValidation(
    { outputSchema: gmailSendOutputSchema },
    {
      output: { adapter: "composio-sdk", result: { successful: true, data: inner } },
      actionOutputData: inner,
    },
  );
  assert.deepEqual(resolved, { successful: true, data: inner });
});

test("composio envelope output validates after unwrap", () => {
  const contract = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: {
      type: "object",
      properties: { recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["recipient_email", "subject", "body"],
    },
    outputSchema: gmailSendOutputSchema,
  });
  const inner = { id: "msg123", threadId: "t1" };
  const resolved = resolveConnectorOutputForValidation(contract, {
    output: { adapter: "composio-sdk", result: { successful: true, data: inner } },
    actionOutputData: inner,
  });
  const validation = validateConnectorActionOutput(contract, resolved);
  assert.equal(validation.valid, true, validation.errors.map((e) => `${e.path} ${e.message}`).join("; "));
});

test("validating inner actionOutputData alone fails composio envelope schema", () => {
  const contract = { outputSchema: gmailSendOutputSchema };
  const inner = { id: "msg123", threadId: "t1" };
  const validation = validateConnectorActionOutput(contract, inner);
  assert.equal(validation.valid, false);
});

test("sanitizeComposioProviderOutput drops null composio_execution_message before validation", () => {
  const outputSchema = {
    type: "object",
    required: ["data", "successful"],
    properties: {
      data: {
        type: "object",
        properties: {
          response_data: { type: "object", additionalProperties: true },
          composio_execution_message: { type: "string" },
        },
      },
      successful: { type: "boolean" },
    },
  };
  const resolved = sanitizeComposioProviderOutput({
    successful: true,
    data: {
      response_data: { id: "evt_123", summary: "Team sync" },
      composio_execution_message: null,
    },
  });
  const validation = validateConnectorActionOutput({ outputSchema }, resolved);
  assert.equal(validation.valid, true, validation.errors.map((e) => `${e.path} ${e.message}`).join("; "));
});

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeComposioExecutionResult } from "../../../src/services/connectors/composio.js";
import {
  extractEmailAddresses,
  mergeStableConfigWithRuntimeInputs,
  normalizeConnectorPayloadForSchema,
  validateConnectorActionPayload,
} from "../../../src/services/conductor/runtime/connector-action-payload.js";
import { buildPriorOutputIndex, extractStructuredOutputFromArtifact, resolveAgentHandoffBindings } from "../../../src/services/conductor/runtime/typed-handoff.js";
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

test("prior output index resolves agent_output bindings when artifact id differs from agent id", () => {
  const priorOutputs = buildPriorOutputIndex({
    artifacts: [{
      artifact_key: "final_email_draft",
      agent_id: "email_composer",
      envelope: {
        data: {
          data: { structuredOutput: { subject: "Weekly briefing", body: "Shipped loops." } },
        },
      },
    }],
    children: [{ id: "email_composer", outputArtifactId: "final_email_draft" }],
  });
  const resolved = resolveAgentHandoffBindings({
    agent: {
      handoffBindings: [
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/subject" },
          targetPath: "/subject",
          required: true,
        },
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/body" },
          targetPath: "/body",
          required: true,
        },
      ],
    },
    priorOutputs,
    operatorInputs: {},
  });
  assert.deepEqual(resolved.value, { subject: "Weekly briefing", body: "Shipped loops." });
});

test("structured email handoff derives subject when composer output only includes body", () => {
  const priorOutputs = buildPriorOutputIndex({
    artifacts: [{
      artifact_key: "final_email_draft",
      agent_id: "email_composer",
      envelope: {
        data: {
          data: { structuredOutput: { body: "# Weekly update\n\nShipped loops." } },
        },
      },
    }],
    children: [{ id: "email_composer", outputArtifactId: "final_email_draft" }],
  });
  const resolved = resolveAgentHandoffBindings({
    agent: {
      handoffBindings: [
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/subject" },
          targetPath: "/subject",
          required: true,
        },
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/body" },
          targetPath: "/body",
          required: true,
        },
      ],
    },
    priorOutputs,
    operatorInputs: {},
  });
  assert.equal(resolved.value.body, "# Weekly update\n\nShipped loops.");
  assert.equal(resolved.value.subject, "Weekly update");
  assert.equal(resolved.resolvedBindings.every((row) => row.resolved), true);
});

test("structured email handoff reads subject from promoted canvas email template", () => {
  const resolved = resolveAgentHandoffBindings({
    agent: {
      handoffBindings: [
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/subject" },
          targetPath: "/subject",
          required: true,
        },
        {
          source: { kind: "agent_output", agentId: "email_composer", path: "/body" },
          targetPath: "/body",
          required: true,
        },
      ],
    },
    priorOutputs: buildPriorOutputIndex({
      artifacts: [{
        artifact_key: "final_email_draft",
        agent_id: "email_composer",
        envelope: {
          data: {
            text: "Body copy only in promoted artifact",
            emailTemplate: {
              subject: "Launch briefing",
              text: "Body copy only in promoted artifact",
            },
          },
        },
      }],
      children: [{ id: "email_composer", outputArtifactId: "final_email_draft" }],
    }),
    operatorInputs: {},
  });
  assert.deepEqual(resolved.value, {
    subject: "Launch briefing",
    body: "Body copy only in promoted artifact",
  });
});

test("extractStructuredOutputFromArtifact survives oversized data_json that data compaction would truncate", () => {
  const longBody = `# Marketing launch\n\n${"Tallei Loops ships now.".repeat(600)}`;
  // Raw artifact data_json as persisted by a normal agent run; serialized > 6000 chars.
  const rawDataJson = {
    text: longBody,
    data: { structuredOutput: { subject: "Launch is live", body: longBody } },
    goalEval: { passed: true },
    artifactEnvelope: { value: { subject: "Launch is live", body: longBody } },
  };
  assert.ok(JSON.stringify(rawDataJson).length > 6_000, "fixture must exceed the 6k compaction threshold");

  const structuredOutput = extractStructuredOutputFromArtifact(rawDataJson, longBody);
  assert.equal(structuredOutput?.subject, "Launch is live");
  assert.equal(structuredOutput?.body, longBody);

  // Simulate the envelope the runtime builds: data is truncated, but structuredOutput is preserved.
  const priorOutputs = buildPriorOutputIndex({
    artifacts: [{
      artifact_key: "final_email_draft",
      agent_id: "email_composer",
      envelope: {
        data: { truncated: true, originalSizeChars: JSON.stringify(rawDataJson).length, excerpt: "{\"text\":\"# Marketing" },
        structuredOutput,
      },
    }],
    children: [{ id: "email_composer", outputArtifactId: "final_email_draft" }],
  });
  const resolved = resolveAgentHandoffBindings({
    agent: {
      handoffBindings: [
        { source: { kind: "agent_output", agentId: "email_composer", path: "/subject" }, targetPath: "/subject", required: true },
        { source: { kind: "agent_output", agentId: "email_composer", path: "/body" }, targetPath: "/body", required: true },
      ],
    },
    priorOutputs,
    operatorInputs: {},
  });
  assert.equal(resolved.value.subject, "Launch is live");
  assert.equal(resolved.value.body, longBody);
  assert.equal(resolved.resolvedBindings.every((row) => row.resolved), true);
});

test("extractStructuredOutputFromArtifact parses a JSON body string when structured fields are absent", () => {
  const structuredOutput = extractStructuredOutputFromArtifact(
    { goalEval: { passed: true } },
    JSON.stringify({ subject: "Quarterly recap", body: "Numbers are up." }),
  );
  assert.equal(structuredOutput?.subject, "Quarterly recap");
  assert.equal(structuredOutput?.body, "Numbers are up.");
});

test("normalizeConnectorPayloadForSchema coerces contact csv strings into gmail bcc arrays", () => {
  const schema = {
    type: "object",
    properties: {
      recipient_email: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      bcc: { type: "array", items: { type: "string" } },
    },
  };
  const normalized = normalizeConnectorPayloadForSchema({
    recipient_email: "lead@example.com",
    subject: "Launch",
    body: "Hello",
    bcc: "audit@example.com, finance@example.com",
  }, schema);
  assert.deepEqual(normalized.bcc, ["audit@example.com", "finance@example.com"]);
  assert.equal(validateConnectorActionPayload({ inputSchema: schema }, normalized).valid, true);
});

test("normalizeConnectorPayloadForSchema drops invalid optional bcc values instead of failing validation", () => {
  const schema = {
    type: "object",
    properties: {
      recipient_email: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      bcc: { type: "array", items: { type: "string" } },
    },
    required: ["recipient_email", "subject", "body"],
  };
  const normalized = normalizeConnectorPayloadForSchema({
    recipient_email: "lead@example.com",
    subject: "Launch",
    body: "Hello",
    bcc: "",
  }, schema);
  assert.equal("bcc" in normalized, false);
  assert.equal(validateConnectorActionPayload({ inputSchema: schema }, normalized).valid, true);
});

test("extractEmailAddresses reads contacts_csv operator input envelopes", () => {
  assert.deepEqual(
    extractEmailAddresses({
      contacts: [
        { email: "ops@example.com", name: "Ops" },
        { email: "audit@example.com" },
      ],
    }),
    ["ops@example.com", "audit@example.com"],
  );
});

test("normalizeConnectorPayloadForSchema coerces contacts_csv into google calendar attendees arrays", () => {
  const schema = {
    type: "object",
    properties: {
      start_datetime: { type: "string" },
      attendees: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            { type: "object", additionalProperties: true },
          ],
        },
      },
    },
    required: ["start_datetime"],
  };
  const normalized = normalizeConnectorPayloadForSchema({
    start_datetime: "2025-01-16T13:00:00",
    attendees: {
      contacts: [
        { email: "lead@example.com", name: "Lead" },
        { email: "guest@example.com" },
      ],
    },
  }, schema);
  assert.deepEqual(normalized.attendees, ["lead@example.com", "guest@example.com"]);
  assert.equal(validateConnectorActionPayload({ inputSchema: schema }, normalized).valid, true);
});

test("mergeStableConfigWithRuntimeInputs fills workflow_config contacts from runtime operator inputs", () => {
  const merged = mergeStableConfigWithRuntimeInputs(
    {},
    {
      meeting_attendees: {
        contacts: [{ email: "lead@example.com" }],
      },
    },
    [{
      source: { kind: "stable_config", path: "/meeting_attendees" },
    }],
  );
  assert.deepEqual(merged.meeting_attendees, {
    contacts: [{ email: "lead@example.com" }],
  });
});

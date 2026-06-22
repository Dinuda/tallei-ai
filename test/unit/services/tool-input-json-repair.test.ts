import assert from "node:assert/strict";
import test from "node:test";

import { repairArtifactSetupToolInput } from "../../../src/services/loop-builder/artifact-setup-input.js";
import {
  repairPrematureStringTermination,
  repairToolInputJsonString,
  repairUnquotedJsonKeys,
  tryParseToolInputJson,
} from "../../../src/services/loop-builder/tool-input-json-repair.js";
import { createLoopBuilderToolCallRepair } from "../../../src/services/loop-builder/tool-call-repair.js";
import { InvalidToolInputError } from "ai";

const BROKEN_ARTIFACT_SETUP = "{\"requirementId\": \"artifact_contract\", \"draftTemplates\": [{\"templateId\":\"acknowledgment\",\"name\":\"Acknowledgment Reply\",\"props\":{\"subject\":\"Re: {{customer_subject}}\",\"previewText\":\"Thanks for reaching out — we've received your request\",\"greeting\":\"Hi {{customer_name}},\" body\":\"Thanks for contactingour support team. We've received your message and will get back to you shortly.\\n\\nYour request hasbeen logged and we'll prioritize it accordingly.\",\"signOff\":\"Best regards,\\n{{agent_name}}\"}},{\"templateId\":\"troubleshooting\",\"name\":\"Troubleshooting / Info Request\",\"props\":{\"subject\":\"Re: {{customer_subject}}\",\"previewText\":\"A few details to help resolve your issue\",\"greeting\":\"Hi {{customer_name}},\" body\":\"Thanks for reaching out.\",\"signOff\":\"Looking forward to your reply,\\n{{agent_name}}\"}}]}";

test("repairPrematureStringTermination fixes missing closing quote before next key", () => {
  const repaired = repairPrematureStringTermination('{"greeting":"Hi {{customer_name}}," body":"Thanks"}');
  const parsed = JSON.parse(repaired);
  assert.equal((parsed as { body: string }).body, "Thanks");
});

test("tryParseToolInputJson repairs unquoted keys in malformed artifactSetup JSON", () => {
  const parsed = tryParseToolInputJson(BROKEN_ARTIFACT_SETUP);
  assert.ok(parsed && typeof parsed === "object");
  const record = parsed as Record<string, unknown>;
  assert.equal(record.requirementId, "artifact_contract");
  assert.ok(Array.isArray(record.draftTemplates));
});

test("repairArtifactSetupToolInput returns valid schema JSON for broken model output", () => {
  const repaired = repairArtifactSetupToolInput(BROKEN_ARTIFACT_SETUP);
  assert.ok(repaired);
  const parsed = JSON.parse(repaired!);
  assert.equal(parsed.requirementId, "artifact_contract");
  assert.ok(Array.isArray(parsed.draftTemplates));
  assert.ok(parsed.draftTemplates.length >= 2);
  assert.equal(parsed.draftTemplates[0]?.templateId, "acknowledgment");
});

test("repairArtifactSetupToolInput falls back to defaults when JSON is unrecoverable", () => {
  const repaired = repairArtifactSetupToolInput("not json at all but templateId acknowledgment");
  assert.ok(repaired);
  const parsed = JSON.parse(repaired!);
  assert.equal(parsed.requirementId, "artifact_contract");
  assert.deepEqual(
    parsed.draftTemplates.map((entry: { templateId: string }) => entry.templateId),
    ["acknowledgment"],
  );
});

test("createLoopBuilderToolCallRepair silently repairs artifactSetup tool calls", async () => {
  const repair = createLoopBuilderToolCallRepair("Support inbox loop");
  const repaired = await repair({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_artifact",
      toolName: "artifactSetup",
      input: BROKEN_ARTIFACT_SETUP,
    },
    tools: {},
    inputSchema: async () => ({}),
    system: undefined,
    messages: [],
    error: new InvalidToolInputError({
      toolName: "artifactSetup",
      toolInput: BROKEN_ARTIFACT_SETUP,
      cause: new Error("JSON parsing failed"),
    }),
  });

  assert.ok(repaired);
  const input = JSON.parse(repaired!.input);
  assert.equal(input.requirementId, "artifact_contract");
  assert.ok(input.draftTemplates?.length > 0);
});

test("repairToolInputJsonString repairs requirementSetup-style payloads", () => {
  const broken = "{\"requirementId\":\"review_policy\",\"question\":\"How review?\",\"options\":[{\"id\":\"draft_only\",\"label\":\"Draft only\",\"value\":\"draft_only\"}],\"allowOther\":true}";
  const repaired = repairToolInputJsonString(broken);
  assert.ok(repaired);
  const parsed = JSON.parse(repaired!);
  assert.equal(parsed.requirementId, "review_policy");
});

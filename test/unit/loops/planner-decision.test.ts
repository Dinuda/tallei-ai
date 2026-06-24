import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonObject,
  normalizePlannerDecision,
  parsePlannerDecisionText,
} from "../../../src/loops/planning-agent.js";

test("normalizePlannerDecision infers tool_call when kind is missing", () => {
  const normalized = normalizePlannerDecision({
    toolId: "tool_email_send",
    args: { to: "user@example.com", subject: "Hi", body: "Hello" },
    reasoning: "Send reply",
  });
  assert.deepEqual(normalized, {
    kind: "tool_call",
    toolId: "tool_email_send",
    args: { to: "user@example.com", subject: "Hi", body: "Hello" },
    reasoning: "Send reply",
  });
});

test("normalizePlannerDecision infers finish from summary", () => {
  const normalized = normalizePlannerDecision({ summary: "Done" });
  assert.deepEqual(normalized, { kind: "finish", summary: "Done" });
});

test("parsePlannerDecisionText parses fenced JSON and missing kind", () => {
  const decision = parsePlannerDecisionText(`\`\`\`json
{
  "toolId": "tool_email_send",
  "args": { "to": "a@b.com" },
  "reasoning": "reply"
}
\`\`\``);
  assert.equal(decision.kind, "tool_call");
  if (decision.kind === "tool_call") {
    assert.equal(decision.toolId, "tool_email_send");
  }
});

test("extractJsonObject pulls object from prose", () => {
  assert.equal(
    extractJsonObject('Here you go {"kind":"finish","summary":"ok"}'),
    '{"kind":"finish","summary":"ok"}',
  );
});

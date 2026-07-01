import assert from "node:assert/strict";
import test from "node:test";

import type { CompiledPlan } from "../../../src/loops/spec.js";
import { checkTestRunProfile, resolveTestRunTimeoutMs } from "../../../src/loops/test-run.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const loopId = "00000000-0000-4000-8000-000000000002";
const planId = "00000000-0000-4000-8000-000000000003";

function basePlan(partial: Partial<CompiledPlan>): CompiledPlan {
  return {
    id: planId,
    loopId,
    workspaceId,
    specRevision: 1,
    revision: 1,
    contentHash: "abc",
    profile: "agentic",
    intent: { goal: "Triage email", outcome: "Reply drafted", successCriteria: [] },
    trigger: { kind: "manual" },
    connectorPlaybook: {
      compiledAt: new Date().toISOString(),
      useCase: "Reply drafted",
    },
    toolCatalog: [{
      id: "tool_email_read",
      capability: "email.read",
      connector: "gmail",
      actionSlug: "GMAIL_FETCH_EMAILS",
      inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
      plannerCard: {
        summary: "List Gmail messages",
        argGuides: {},
      },
      sensitive: false,
      credentialRef: "acc-1",
    }],
    output: { kind: "none" },
    approval: { mode: "mixed", sensitiveRoles: [], sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
    guardrails: { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
    compiledAt: new Date().toISOString(),
    status: "draft",
    ...partial,
  };
}

test("checkTestRunProfile fails monitor without rule", () => {
  const result = checkTestRunProfile(basePlan({
    profile: "monitor",
    monitor: undefined,
  }));
  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.error, "monitor_rule_missing");
  }
});

test("checkTestRunProfile fails sync without mapping", () => {
  const result = checkTestRunProfile(basePlan({
    profile: "sync",
    sync: {
      left: { connector: "hubspot", object: "contact" },
      right: { connector: "salesforce", object: "contact" },
      mapping: {},
      conflictPolicy: "newest_wins",
      direction: "bidirectional",
    },
  }));
  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.error, "sync_config_incomplete");
  }
});

test("checkTestRunProfile returns null for valid monitor plan", () => {
  const result = checkTestRunProfile(basePlan({
    profile: "monitor",
    monitor: { source: "metrics.cpu", rule: { op: "gt", field: "value", value: 80 } },
  }));
  assert.equal(result, null);
});

test("checkTestRunProfile fails agentic plan without connector playbook", () => {
  const result = checkTestRunProfile(basePlan({
    connectorPlaybook: undefined as never,
  }));
  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.match(result.error, /connectorPlaybook/i);
  }
});

test("resolveTestRunTimeoutMs allows at least one planner call per step", () => {
  const twoSteps = resolveTestRunTimeoutMs(2);
  assert.ok(twoSteps >= 45_000, `expected >= 45s, got ${twoSteps}`);
  assert.equal(resolveTestRunTimeoutMs(2, 90_000), 90_000);
});

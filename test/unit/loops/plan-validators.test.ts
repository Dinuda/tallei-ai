import assert from "node:assert/strict";
import test from "node:test";

import { assertAgenticCompiledPlan, validateAgenticCompileArtifacts } from "../../../src/loops/plan-validators.js";
import type { CompiledPlan } from "../../../src/loops/spec.js";

const basePlan = (): CompiledPlan => ({
  id: "00000000-0000-4000-8000-000000000003",
  loopId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  specRevision: 1,
  revision: 1,
  contentHash: "abc",
  profile: "agentic",
  intent: { goal: "Triage", outcome: "Reply drafted", successCriteria: [] },
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
    inputSchema: {},
    plannerCard: { summary: "List Gmail", argGuides: {} },
    sensitive: false,
    credentialRef: "acc-1",
  }],
  composioActions: [],
  output: { kind: "none" },
  approval: { mode: "mixed", sensitiveRoles: [], sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
  guardrails: { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
  compiledAt: new Date().toISOString(),
  status: "draft",
});

test("assertAgenticCompiledPlan passes for complete agentic plan", () => {
  assert.doesNotThrow(() => assertAgenticCompiledPlan(basePlan()));
});

test("assertAgenticCompiledPlan rejects missing connectorPlaybook", () => {
  const plan = basePlan();
  (plan as { connectorPlaybook?: unknown }).connectorPlaybook = undefined;
  assert.throws(
    () => assertAgenticCompiledPlan(plan),
    /connectorPlaybook/,
  );
});

test("validateAgenticCompileArtifacts reports missing planner cards", () => {
  const errors = validateAgenticCompileArtifacts("agentic", [{
    id: "tool_x",
    plannerCard: undefined,
  }], {
    compiledAt: new Date().toISOString(),
    useCase: "x",
  });
  assert.equal(errors.some((e) => e.code === "MISSING_PLANNER_CARD"), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComposioActionInstruction,
  resolveComposioActionArgs,
  validateComposioActionInstructions,
} from "../../../src/loops/composio-action-instructions.js";
import type { CompiledPlan } from "../../../src/loops/spec.js";

const inputSchema = {
  type: "object",
  required: ["item_id", "label_id"],
  properties: {
    item_id: { type: "string" },
    label_id: { type: "string" },
  },
};

function basePlan(partial: Partial<CompiledPlan> = {}): CompiledPlan {
  const action = {
    toolkit: "example",
    actionSlug: "EXAMPLE_APPLY_LABEL",
    label: "Apply label",
    inputInstructions: [
      {
        field: "item_id",
        required: true,
        sources: [
          { type: "trigger" as const, path: "item_id" },
          { type: "previous_action" as const, actionSlug: "EXAMPLE_QUERY_ITEMS", path: "items.0.id" },
        ],
      },
      {
        field: "label_id",
        required: true,
        sources: [{ type: "static" as const, value: "label-urgent" }],
      },
    ],
    outputInstructions: [],
    dependsOn: ["EXAMPLE_QUERY_ITEMS"],
  };

  return {
    id: "00000000-0000-4000-8000-000000000003",
    loopId: "00000000-0000-4000-8000-000000000002",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    specRevision: 1,
    revision: 1,
    contentHash: "abc",
    profile: "agentic",
    intent: { goal: "Apply labels", outcome: "Items labeled", successCriteria: [] },
    trigger: { kind: "manual" },
    toolCatalog: [{
      id: "tool_example_apply_label",
      capability: "example.apply_label",
      connector: "example",
      actionSlug: "EXAMPLE_APPLY_LABEL",
      inputSchema,
      plannerCard: { summary: "Apply label", argGuides: {} },
      composioAction: action,
      sensitive: false,
      credentialRef: "acc-1",
    }],
    composioActions: [action],
    connectorPlaybook: {
      compiledAt: new Date().toISOString(),
      useCase: "Items labeled",
    },
    output: { kind: "none" },
    approval: { mode: "mixed", sensitiveRoles: [], sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
    guardrails: { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
    compiledAt: new Date().toISOString(),
    status: "draft",
    ...partial,
  };
}

test("buildComposioActionInstruction creates input and output instructions from schemas", () => {
  const instruction = buildComposioActionInstruction({
    toolkit: "example",
    actionSlug: "EXAMPLE_QUERY_ITEMS",
    label: "Query items",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array" } },
    },
  });

  assert.equal(instruction.toolkit, "example");
  assert.equal(instruction.actionSlug, "EXAMPLE_QUERY_ITEMS");
  assert.equal(instruction.inputInstructions[0]?.field, "query");
  assert.equal(instruction.inputInstructions[0]?.sources[0]?.type, "planner");
  assert.equal(instruction.outputInstructions[0]?.name, "items");
});

test("validateComposioActionInstructions fails required inputs without sources", () => {
  const errors = validateComposioActionInstructions({
    tools: [{
      connector: "example",
      actionSlug: "EXAMPLE_APPLY_LABEL",
      inputSchema,
    }],
    instructions: [{
      toolkit: "example",
      actionSlug: "EXAMPLE_APPLY_LABEL",
      label: "Apply label",
      inputInstructions: [{ field: "item_id", required: true, sources: [] }],
      outputInstructions: [],
      dependsOn: [],
    }],
  });

  assert.equal(errors.some((error) => error.code === "MISSING_INPUT_SOURCE"), true);
});

test("resolveComposioActionArgs fills required args from trigger and static sources", () => {
  const plan = basePlan();
  const tool = plan.toolCatalog[0]!;
  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: {},
    eventPayload: { item_id: "item-123" },
    toolResults: [],
  });

  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.args.item_id, "item-123");
  assert.equal(resolved.args.label_id, "label-urgent");
});

test("resolveComposioActionArgs fills required args from previous action outputs", () => {
  const plan = basePlan({
    toolCatalog: [
      {
        id: "tool_example_query_items",
        capability: "example.query",
        connector: "example",
        actionSlug: "EXAMPLE_QUERY_ITEMS",
        inputSchema: {},
        plannerCard: { summary: "Query items", argGuides: {} },
        sensitive: false,
        credentialRef: "acc-1",
      },
      ...basePlan().toolCatalog,
    ],
  });
  const tool = plan.toolCatalog[1]!;
  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: { label_id: "label-vip" },
    toolResults: [{
      toolId: "tool_example_query_items",
      result: { data: { items: [{ id: "item-from-query" }] } },
    }],
  });

  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.args.item_id, "item-from-query");
  assert.equal(resolved.args.label_id, "label-urgent");
});

test("resolveComposioActionArgs reports missing_input_source instead of accepting planner-provided alternate ids", () => {
  const plan = basePlan();
  const tool = plan.toolCatalog[0]!;
  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: { item_id: "planner-invented-item" },
    eventPayload: { thread_id: "not-item-id" },
    toolResults: [],
  });

  assert.equal(resolved.missing[0]?.field, "item_id");
  assert.equal(resolved.missing[0]?.actionSlug, "EXAMPLE_APPLY_LABEL");
  assert.equal(resolved.missing[0]?.toolId, "tool_example_apply_label");
  assert.equal(resolved.args.label_id, "label-urgent");
  assert.equal(resolved.args.item_id, undefined);
});

test("resolveComposioActionArgs accepts planner-provided required args only when source allows planner", () => {
  const plan = basePlan();
  const tool = {
    ...plan.toolCatalog[0]!,
    composioAction: {
      ...plan.toolCatalog[0]!.composioAction!,
      inputInstructions: [
        {
          field: "item_id",
          required: true,
          sources: [{ type: "planner" as const, description: "Choose the current item id from context." }],
        },
        plan.toolCatalog[0]!.composioAction!.inputInstructions[1]!,
      ],
    },
  };

  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: { item_id: "planner-selected-item" },
    eventPayload: { thread_id: "not-item-id" },
    toolResults: [],
  });

  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.args.item_id, "planner-selected-item");
  assert.equal(resolved.args.label_id, "label-urgent");
});

test("resolveComposioActionArgs drops planner fields hidden by the modified schema", () => {
  const currentPlan = basePlan();
  const tool = {
    ...currentPlan.toolCatalog[0]!,
    modifiedInputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  };
  const resolved = resolveComposioActionArgs({
    plan: currentPlan,
    tool,
    args: { query: "status:open", verbose: false, limit: 100 },
    toolResults: [],
  });

  assert.deepEqual(resolved.args, { query: "status:open", label_id: "label-urgent" });
  assert.equal("verbose" in resolved.args, false);
  assert.equal("limit" in resolved.args, false);
});

test("resolveComposioActionArgs carries any optional schema field from the trigger", () => {
  const currentPlan = basePlan();
  const tool = {
    ...currentPlan.toolCatalog[0]!,
    originalInputSchema: {
      type: "object",
      required: ["item_id", "label_id"],
      properties: {
        item_id: { type: "string" },
        label_id: { type: "string" },
        thread_id: { type: "string" },
        priority: { type: "string" },
      },
    },
  };
  const resolved = resolveComposioActionArgs({
    plan: currentPlan,
    tool,
    args: {},
    eventPayload: { item_id: "item-123", thread_id: "thread-123", priority: "high", ignored: "value" },
    toolResults: [],
  });

  assert.equal(resolved.args.thread_id, "thread-123");
  assert.equal(resolved.args.priority, "high");
  assert.equal(resolved.args.ignored, undefined);
});

test("resolveComposioActionArgs gives explicit optional planner args precedence over trigger values", () => {
  const currentPlan = basePlan();
  const schema = {
    type: "object",
    required: ["item_id", "label_id"],
    properties: {
      item_id: { type: "string" },
      label_id: { type: "string" },
      priority: { type: "string" },
    },
  };
  const tool = {
    ...currentPlan.toolCatalog[0]!,
    inputSchema: schema,
    originalInputSchema: schema,
  };
  const resolved = resolveComposioActionArgs({
    plan: currentPlan,
    tool,
    args: { priority: "planner" },
    eventPayload: { item_id: "item-123", priority: "trigger" },
    toolResults: [],
  });

  assert.equal(resolved.args.priority, "planner");
});

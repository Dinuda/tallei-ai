import { z } from "zod";
import { ignoreOverride, zodToJsonSchema } from "zod-to-json-schema";

import { inputSurfaceSchema, type InputRequirement } from "./input-surfaces.js";
import { dataContractSchema } from "./data-contract.js";
import {
  loopAgentGraphSchema,
  type AgentHandoffBinding,
  type LoopAgentGraph,
} from "../loop-executor/types.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";

const evidenceSchema = z.object({
  source: z.enum(["user_prompt", "intent_context", "tool_contract", "saved_context", "model_reasoning"]),
  reference: z.string().min(1),
  explanation: z.string().min(1),
});

export const planningDecisionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["outcome", "schedule", "delivery", "approval", "input_lifecycle", "action_selection"]),
  decision: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

export const plannedRequiredValueSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  lifecycle: z.enum(["workflow_config", "runtime_input", "derived"]),
  timing: z.enum(["run_start", "before_step", "before_action"]),
  sensitivity: z.enum(["public", "private", "secret"]),
  valueSchema: z.record(z.unknown()),
  surface: inputSurfaceSchema,
  allowedSourceKinds: z.array(z.enum([
    "agent_output",
    "operator_input",
    "stable_config",
    "artifact",
    "connector_output",
  ])).min(1),
  status: z.enum(["resolved", "unresolved"]),
  stableValue: z.unknown().optional(),
  evidence: z.array(evidenceSchema).min(1),
});

const plannedBindingSourceSchema = z.object({
  kind: z.enum(["agent_output", "required_value", "stable_config", "artifact", "connector_output"]),
  nodeId: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  path: z.string().min(1).default("/"),
});

export const explicitActionInputBindingSchema = z.object({
  source: plannedBindingSourceSchema,
  targetPath: z.string().min(1),
  required: z.boolean().default(true),
  valuePolicy: z.enum(["derivable", "passthrough"]),
  provenance: z.enum(["agent_output", "operator_input", "stable_config", "artifact", "connector_output"]),
});

const semanticAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  responsibility: z.string().min(1),
  goal: z.string().min(1),
  task: z.string().min(1),
  toolRef: z.string().min(1),
  toolConfig: z.record(z.unknown()).optional(),
  inputContract: z.object({
    description: z.string().min(1),
    schema: z.record(z.unknown()).default({}),
  }),
  inputBindings: z.array(explicitActionInputBindingSchema).default([]),
  outputContract: dataContractSchema,
  doneCriteria: z.array(z.string().min(1)).min(1).max(8),
  reviewGate: z.object({
    type: z.enum(["memory_confirmation", "source_confirmation", "draft_review"]),
    question: z.string().min(1),
  }).optional(),
});

export const actionSemanticAnnotationSchema = z.object({
  effect: z.enum(["read_external", "write_external", "irreversible_external", "uncertain"]),
  confidence: z.enum(["low", "medium", "high"]),
  approvalRequired: z.boolean(),
  evidence: z.array(evidenceSchema).min(1),
  semanticAssertions: z.array(z.object({
    kind: z.enum(["at_least_one", "non_placeholder"]),
    paths: z.array(z.string().min(1)).min(1),
    message: z.string().min(1),
    evidence: z.array(evidenceSchema).min(1),
  })).default([]),
  fieldPolicies: z.array(z.object({
    path: z.string().min(1),
    valuePolicy: z.enum(["derivable", "passthrough"]),
    required: z.boolean(),
    allowedSourceKinds: z.array(z.enum([
      "agent_output",
      "operator_input",
      "stable_config",
      "artifact",
      "connector_output",
    ])).min(1),
    evidence: z.array(evidenceSchema).min(1),
  })).default([]),
});

export const selectedConnectorActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  toolRef: z.string().min(1),
  purpose: z.string().min(1),
  stableConfig: z.record(z.unknown()).default({}),
  annotation: actionSemanticAnnotationSchema,
  bindings: z.array(explicitActionInputBindingSchema).default([]),
  doneCriteria: z.array(z.string().min(1)).min(1).max(8),
});

export const unresolvedPlanningIssueSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["decision", "required_value", "action", "binding", "contract"]),
  message: z.string().min(1),
  blocksApproval: z.boolean(),
  relatedRef: z.string().min(1).optional(),
});

export const loopPlanningIRSchema = z.object({
  version: z.literal("v1"),
  title: z.string().min(1),
  summary: z.string().min(1),
  strategy: z.string().min(1),
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }),
  decisions: z.array(planningDecisionSchema).default([]),
  requiredValues: z.array(plannedRequiredValueSchema).default([]),
  semanticAgents: z.array(semanticAgentSchema).max(12).default([]),
  selectedActions: z.array(selectedConnectorActionSchema).default([]),
  unresolvedIssues: z.array(unresolvedPlanningIssueSchema).default([]),
  rationale: z.array(z.string().min(1)).default([]),
  suggestedChannels: z.array(z.string().min(1)).default(["primary"]),
});

function makePlannerJsonSchemaStrict(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(makePlannerJsonSchemaStrict);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (
    (row.$ref === "#/definitions/OpenAiAnyType")
    || (row.type === "object" && row.additionalProperties && typeof row.additionalProperties === "object")
  ) {
    return {
      type: "string",
      description: "JSON-encoded value. Return valid JSON text for this field.",
    };
  }
  const result = Object.fromEntries(Object.entries(row).map(([key, entry]) => [
    key,
    makePlannerJsonSchemaStrict(entry),
  ]));
  delete result.default;
  delete result.$schema;
  if (result.definitions && typeof result.definitions === "object" && !Array.isArray(result.definitions)) {
    delete (result.definitions as Record<string, unknown>).OpenAiAnyType;
  }
  return result;
}

export const loopPlanningIRJsonSchema = makePlannerJsonSchemaStrict(zodToJsonSchema(loopPlanningIRSchema, {
  target: "openAi",
  $refStrategy: "none",
  override: (definition) => (
    (definition as { typeName?: string }).typeName === "ZodRecord"
    || (definition as { typeName?: string }).typeName === "ZodAny"
    || (definition as { typeName?: string }).typeName === "ZodUnknown"
      ? {
          type: "string",
          description: "JSON-encoded value. Return valid JSON text for this field.",
        }
      : ignoreOverride
  ),
})) as Record<string, unknown>;

export type LoopPlanningIR = z.infer<typeof loopPlanningIRSchema>;
export type PlanningDecision = z.infer<typeof planningDecisionSchema>;
export type PlannedRequiredValue = z.infer<typeof plannedRequiredValueSchema>;
export type ExplicitActionInputBinding = z.infer<typeof explicitActionInputBindingSchema>;
export type SelectedConnectorAction = z.infer<typeof selectedConnectorActionSchema>;
export type UnresolvedPlanningIssue = z.infer<typeof unresolvedPlanningIssueSchema>;

export type PlanningCompilationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type CompiledLoopPlanningIR = {
  graph: LoopAgentGraph;
  inputRequirements: InputRequirement[];
  connectorPolicy: {
    allowedReadActions: Array<{ toolkit: string; actionSlug: string; risk: "read"; description: string; requiresPreSendApproval: false }>;
    allowedWriteActions: Array<{ toolkit: string; actionSlug: string; risk: "write" | "destructive"; description: string; requiresPreSendApproval: true }>;
  };
};

function schemaRequiredPaths(schema: Record<string, unknown>, base = ""): string[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  return required.flatMap((key) => {
    const path = `${base}/${key}`;
    const child = properties[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) return [path];
    const nested = schemaRequiredPaths(child as Record<string, unknown>, path);
    return nested.length > 0 ? nested : [path];
  });
}

function schemaAtPath(schema: Record<string, unknown>, path: string): Record<string, unknown> | null {
  if (path === "/") return schema;
  let current: Record<string, unknown> | null = schema;
  for (const segment of path.split("/").filter(Boolean)) {
    if (!current) return null;
    if (current.type === "array") {
      current = current.items && typeof current.items === "object" && !Array.isArray(current.items)
        ? current.items as Record<string, unknown>
        : null;
      continue;
    }
    const properties = current.properties && typeof current.properties === "object" && !Array.isArray(current.properties)
      ? current.properties as Record<string, unknown>
      : {};
    const next = properties[segment];
    current = next && typeof next === "object" && !Array.isArray(next)
      ? next as Record<string, unknown>
      : null;
  }
  return current;
}

function schemasCompatible(source: Record<string, unknown>, target: Record<string, unknown>): boolean {
  const sourceType = typeof source.type === "string" ? source.type : null;
  const targetType = typeof target.type === "string" ? target.type : null;
  return !sourceType || !targetType || sourceType === targetType
    || (sourceType === "integer" && targetType === "number");
}

function bindingSourceToRuntime(
  binding: ExplicitActionInputBinding,
  requiredValues: Map<string, PlannedRequiredValue>,
): AgentHandoffBinding["source"] | null {
  const source = binding.source;
  if (source.kind === "agent_output" || source.kind === "connector_output") {
    return source.nodeId ? { kind: "agent_output", agentId: source.nodeId, path: source.path } : null;
  }
  if (source.kind === "required_value") {
    const value = source.key ? requiredValues.get(source.key) : undefined;
    if (!value) return null;
    if (value.lifecycle === "runtime_input") {
      return { kind: "operator_input", key: value.key, path: source.path };
    }
    if (value.lifecycle === "workflow_config") {
      return { kind: "stable_config", path: `/${value.key}${source.path === "/" ? "" : source.path}` };
    }
    return null;
  }
  if (source.kind === "stable_config") return { kind: "stable_config", path: source.path };
  if (source.kind === "artifact") return source.key ? { kind: "artifact", key: source.key, path: source.path } : null;
  return null;
}

function compileBindings(
  bindings: ExplicitActionInputBinding[],
  requiredValues: Map<string, PlannedRequiredValue>,
  issues: PlanningCompilationIssue[],
  owner: string,
): AgentHandoffBinding[] {
  return bindings.flatMap((binding, index) => {
    const source = bindingSourceToRuntime(binding, requiredValues);
    if (!source) {
      issues.push({
        code: "invalid_binding_source",
        message: `${owner} binding ${binding.targetPath} has no declared runtime source.`,
        path: `${owner}.bindings[${index}]`,
      });
      return [];
    }
    return [{
      source,
      targetPath: binding.targetPath,
      required: binding.required,
      valuePolicy: binding.valuePolicy,
      provenance: binding.provenance,
      transformation: "direct" as const,
    }];
  });
}

function validateBinding(input: {
  binding: ExplicitActionInputBinding;
  owner: string;
  targetSchema: Record<string, unknown>;
  outputSchemas: Map<string, Record<string, unknown>>;
  requiredValues: Map<string, PlannedRequiredValue>;
  stableConfig?: Record<string, unknown>;
  issues: PlanningCompilationIssue[];
}): void {
  const { binding, owner, targetSchema, outputSchemas, requiredValues, stableConfig, issues } = input;
  const target = schemaAtPath(targetSchema, binding.targetPath);
  if (!target) {
    issues.push({
      code: "unknown_target_path",
      message: `${owner} binding targets a path absent from its exact input contract: ${binding.targetPath}`,
      path: owner,
    });
  }

  if (binding.valuePolicy === "passthrough" && binding.provenance === "agent_output") {
    issues.push({
      code: "generated_passthrough",
      message: `${owner} passthrough input ${binding.targetPath} cannot originate from a generative agent.`,
      path: owner,
    });
  }

  const expectedDirectProvenance = binding.source.kind === "agent_output"
    ? "agent_output"
    : binding.source.kind === "connector_output"
      ? "connector_output"
      : binding.source.kind === "stable_config"
        ? "stable_config"
        : binding.source.kind === "artifact"
          ? "artifact"
          : null;
  if (expectedDirectProvenance && binding.provenance !== expectedDirectProvenance) {
    issues.push({
      code: "binding_provenance_mismatch",
      message: `${owner} binding ${binding.targetPath} declares ${binding.provenance} provenance for a ${binding.source.kind} source.`,
      path: owner,
    });
  }

  let sourceSchema: Record<string, unknown> | null | undefined;
  if (binding.source.kind === "required_value") {
    const value = binding.source.key ? requiredValues.get(binding.source.key) : undefined;
    if (!value) {
      issues.push({
        code: "unknown_required_value",
        message: `${owner} binding ${binding.targetPath} references an unknown required value.`,
        path: owner,
      });
      return;
    }
    const expectedProvenance = value.lifecycle === "runtime_input"
      ? "operator_input"
      : value.lifecycle === "workflow_config"
        ? "stable_config"
        : null;
    if (!expectedProvenance || binding.provenance !== expectedProvenance) {
      issues.push({
        code: "required_value_provenance",
        message: `${owner} binding ${binding.targetPath} provenance does not match required value ${value.key}.`,
        path: owner,
      });
    }
    if (!value.allowedSourceKinds.includes(binding.provenance)) {
      issues.push({
        code: "required_value_source_policy",
        message: `${owner} binding ${binding.targetPath} violates required value ${value.key} source policy.`,
        path: owner,
      });
    }
    sourceSchema = value.valueSchema;
  } else if (binding.source.kind === "agent_output" || binding.source.kind === "connector_output") {
    sourceSchema = binding.source.nodeId
      ? schemaAtPath(outputSchemas.get(binding.source.nodeId) ?? {}, binding.source.path)
      : null;
    if (!sourceSchema) {
      issues.push({
        code: "unknown_source_path",
        message: `${owner} binding source path does not exist: ${binding.source.nodeId ?? "unknown"}${binding.source.path}`,
        path: owner,
      });
    }
  } else if (binding.source.kind === "stable_config") {
    const segments = binding.source.path.split("/").filter(Boolean);
    let current: unknown = stableConfig;
    for (const segment of segments) {
      current = current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    }
    if (current === undefined) {
      issues.push({
        code: "unknown_stable_config_path",
        message: `${owner} binding ${binding.targetPath} references absent stable configuration ${binding.source.path}.`,
        path: owner,
      });
    }
  }

  if (sourceSchema && target && !schemasCompatible(sourceSchema, target)) {
    issues.push({
      code: "incompatible_binding",
      message: `${owner} binding ${binding.targetPath} has an incompatible source type.`,
      path: owner,
    });
  }
}

function stableConfigForAction(
  action: SelectedConnectorAction,
  requiredValues: Map<string, PlannedRequiredValue>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...action.stableConfig };
  for (const binding of action.bindings) {
    if (binding.source.kind !== "required_value" || !binding.source.key) continue;
    const value = requiredValues.get(binding.source.key);
    if (value?.lifecycle === "workflow_config" && value.status === "resolved" && value.stableValue !== undefined) {
      result[value.key] = value.stableValue;
    }
  }
  return result;
}

export function compileLoopPlanningIR(input: {
  planningIR: LoopPlanningIR;
  contracts: ToolContract[];
}): { ok: true; compiled: CompiledLoopPlanningIR } | { ok: false; issues: PlanningCompilationIssue[] } {
  const ir = loopPlanningIRSchema.parse(input.planningIR);
  const issues: PlanningCompilationIssue[] = ir.unresolvedIssues
    .filter((issue) => issue.blocksApproval)
    .map((issue) => ({ code: `unresolved_${issue.kind}`, message: issue.message, path: issue.relatedRef }));
  const requiredValues = new Map(ir.requiredValues.map((value) => [value.key, value]));
  const contracts = new Map(input.contracts.map((contract) => [contract.toolRef.toLowerCase(), contract]));
  const nodeIds = new Set<string>();
  const consumedSemanticOutputs = new Set<string>();
  const consumedRequiredValues = new Set<string>();
  const outputSchemas = new Map(ir.semanticAgents.map((agent) => [agent.id, agent.outputContract.schema]));
  for (const action of ir.selectedActions) {
    const contract = contracts.get(action.toolRef.toLowerCase());
    if (contract) outputSchemas.set(action.id, contract.outputSchema);
  }
  const responsibilities = new Set<string>();

  if (ir.semanticAgents.length === 0 && ir.selectedActions.length === 0) {
    issues.push({ code: "empty_plan", message: "Planning IR must declare at least one semantic agent or connector action." });
  }

  for (const value of ir.requiredValues) {
    if (value.status === "unresolved" && value.lifecycle !== "derived") {
      issues.push({ code: "unresolved_required_value", message: `Required value "${value.key}" is unresolved.`, path: value.key });
    }
  }

  const semanticChildren = ir.semanticAgents.map((agent) => {
    if (nodeIds.has(agent.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${agent.id}`, path: agent.id });
    nodeIds.add(agent.id);
    const responsibility = agent.responsibility.trim().toLowerCase();
    if (responsibilities.has(responsibility)) {
      issues.push({ code: "duplicate_responsibility", message: `Semantic responsibility is declared more than once: ${agent.responsibility}`, path: agent.id });
    }
    responsibilities.add(responsibility);
    if (parseConnectorActionToolRef(agent.toolRef)) {
      issues.push({ code: "connector_in_semantic_agent", message: `Semantic agent ${agent.id} cannot execute connector action ${agent.toolRef}.`, path: agent.id });
    }
    const semanticContract = contracts.get(agent.toolRef.toLowerCase());
    if (!semanticContract || semanticContract.provider !== "internal") {
      issues.push({ code: "unknown_semantic_tool", message: `Semantic agent ${agent.id} must use an exact available internal tool contract: ${agent.toolRef}.`, path: agent.id });
    }
    for (const binding of agent.inputBindings) {
      if ((binding.source.kind === "agent_output" || binding.source.kind === "connector_output") && binding.source.nodeId) {
        consumedSemanticOutputs.add(binding.source.nodeId);
      }
      if (binding.source.kind === "required_value" && binding.source.key) {
        consumedRequiredValues.add(binding.source.key);
      }
      validateBinding({
        binding,
        owner: agent.id,
        targetSchema: agent.inputContract.schema,
        outputSchemas,
        requiredValues,
        stableConfig: agent.toolConfig,
        issues,
      });
    }
    return {
      id: agent.id,
      name: agent.name,
      nodeKind: "agent" as const,
      task: agent.task,
      goal: agent.goal,
      tools: [{ ref: agent.toolRef, ...(agent.toolConfig ? { config: agent.toolConfig } : {}) }],
      doneCriteria: agent.doneCriteria,
      inputContract: agent.inputContract,
      outputContract: agent.outputContract,
      handoffBindings: compileBindings(agent.inputBindings, requiredValues, issues, agent.id),
      ...(agent.reviewGate ? { gate: agent.reviewGate } : {}),
      outputArtifactId: `${agent.id}_output`,
      outputArtifactKind: "structured_output",
    };
  });

  const readActions: CompiledLoopPlanningIR["connectorPolicy"]["allowedReadActions"] = [];
  const writeActions: CompiledLoopPlanningIR["connectorPolicy"]["allowedWriteActions"] = [];
  const actionChildren = ir.selectedActions.flatMap((action) => {
    if (nodeIds.has(action.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${action.id}`, path: action.id });
    nodeIds.add(action.id);
    const contract = contracts.get(action.toolRef.toLowerCase());
    const parsedRef = parseConnectorActionToolRef(action.toolRef);
    if (!contract || !parsedRef) {
      issues.push({ code: "unknown_action", message: `Selected action has no exact discovered contract: ${action.toolRef}`, path: action.id });
      return [];
    }
    const declaredRisk = String(contract.constraints.risk ?? "").toLowerCase();
    if (declaredRisk && declaredRisk !== "read" && action.annotation.effect === "read_external") {
      issues.push({
        code: "unsafe_risk_annotation",
        message: `${action.toolRef} is not declared read-only by its exact contract and cannot be planned as a read action.`,
        path: action.id,
      });
    }
    for (const assertion of action.annotation.semanticAssertions) {
      for (const path of assertion.paths) {
        if (path !== "/" && !schemaAtPath(contract.inputSchema, path)) {
          issues.push({
            code: "unknown_assertion_path",
            message: `${action.toolRef} semantic assertion references a path absent from the exact input schema: ${path}`,
            path: action.id,
          });
        }
      }
    }
    for (const binding of action.bindings) {
      if ((binding.source.kind === "agent_output" || binding.source.kind === "connector_output") && binding.source.nodeId) {
        consumedSemanticOutputs.add(binding.source.nodeId);
      }
      const policy = action.annotation.fieldPolicies.find((item) => item.path === binding.targetPath);
      if (!policy) {
        issues.push({ code: "missing_field_policy", message: `${action.toolRef} binding ${binding.targetPath} has no explicit field policy.`, path: action.id });
      } else {
        if (policy.valuePolicy !== binding.valuePolicy) {
          issues.push({ code: "field_policy_mismatch", message: `${action.toolRef} binding ${binding.targetPath} conflicts with its declared value policy.`, path: action.id });
        }
        if (!policy.allowedSourceKinds.includes(binding.provenance)) {
          issues.push({ code: "invalid_provenance", message: `${action.toolRef} binding ${binding.targetPath} uses disallowed provenance ${binding.provenance}.`, path: action.id });
        }
      }
      if (binding.source.kind === "required_value") {
        if (binding.source.key) consumedRequiredValues.add(binding.source.key);
      }
      validateBinding({
        binding,
        owner: action.toolRef,
        targetSchema: contract.inputSchema,
        outputSchemas,
        requiredValues,
        stableConfig: stableConfigForAction(action, requiredValues),
        issues,
      });
    }
    const boundPaths = new Set(action.bindings.map((binding) => binding.targetPath));
    for (const requiredPath of schemaRequiredPaths(contract.inputSchema)) {
      const covered = [...boundPaths].some((boundPath) =>
        boundPath === requiredPath || requiredPath.startsWith(`${boundPath}/`));
      if (!covered) {
        issues.push({ code: "missing_required_binding", message: `${action.toolRef} has no explicit binding for required input ${requiredPath}.`, path: action.id });
      }
    }
    const uncertain = action.annotation.effect === "uncertain" || action.annotation.confidence === "low";
    const requiresApproval = action.annotation.approvalRequired || uncertain
      || action.annotation.effect === "write_external"
      || action.annotation.effect === "irreversible_external";
    if (requiresApproval) {
      writeActions.push({
        toolkit: parsedRef.toolkit,
        actionSlug: parsedRef.actionSlug,
        risk: action.annotation.effect === "irreversible_external" ? "destructive" : "write",
        description: action.purpose,
        requiresPreSendApproval: true,
      });
    } else {
      readActions.push({
        toolkit: parsedRef.toolkit,
        actionSlug: parsedRef.actionSlug,
        risk: "read",
        description: action.purpose,
        requiresPreSendApproval: false,
      });
    }
    const stableConfig = stableConfigForAction(action, requiredValues);
    return [{
      id: action.id,
      name: action.name,
      nodeKind: "action" as const,
      task: action.purpose,
      goal: action.purpose,
      tools: [{ ref: action.toolRef, ...(Object.keys(stableConfig).length > 0 ? { config: stableConfig } : {}) }],
      doneCriteria: action.doneCriteria,
      inputContract: { description: `Exact input contract for ${action.toolRef}`, schema: contract.inputSchema },
      outputContract: {
        description: `Exact output contract for ${action.toolRef}`,
        schema: contract.outputSchema,
        representation: "json" as const,
        mediaType: "application/json" as const,
        visibility: "internal" as const,
      },
      handoffBindings: compileBindings(action.bindings, requiredValues, issues, action.id),
      ...(requiresApproval ? { gate: { type: "pre_send" as const, question: `Approve ${action.purpose}?` } } : {}),
      outputArtifactId: `${action.id}_output`,
      outputArtifactKind: "structured_output",
    }];
  });

  for (const agent of ir.semanticAgents) {
    const isOperatorVisibleTerminal = agent.outputContract.visibility === "operator";
    if (
      !consumedSemanticOutputs.has(agent.id)
      && !isOperatorVisibleTerminal
      && ir.semanticAgents.length + ir.selectedActions.length > 1
    ) {
      issues.push({ code: "unused_semantic_output", message: `Semantic agent ${agent.id} has no declared consumer.`, path: agent.id });
    }
  }
  for (const value of ir.requiredValues) {
    if (value.lifecycle !== "derived" && !consumedRequiredValues.has(value.key)) {
      issues.push({ code: "unused_required_value", message: `Required value ${value.key} has no declared consumer.`, path: value.key });
    }
  }

  const allNodes = [...semanticChildren, ...actionChildren];
  const nodeOrder = new Map(allNodes.map((node, index) => [node.id, index]));
  for (const [nodeIndex, node] of allNodes.entries()) {
    for (const binding of node.handoffBindings) {
      if (binding.source.kind === "agent_output" && binding.source.agentId && !nodeIds.has(binding.source.agentId)) {
        issues.push({ code: "unknown_binding_source", message: `${node.id} references unknown source node ${binding.source.agentId}.`, path: node.id });
      }
      if (
        binding.source.kind === "agent_output"
        && binding.source.agentId
        && (nodeOrder.get(binding.source.agentId) ?? Number.POSITIVE_INFINITY) >= nodeIndex
      ) {
        issues.push({ code: "non_prior_binding_source", message: `${node.id} must consume only an earlier declared node: ${binding.source.agentId}.`, path: node.id });
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const inputRequirements: InputRequirement[] = ir.requiredValues
    .filter((value) => value.lifecycle === "runtime_input")
    .map((value) => ({
      key: value.key,
      surface: value.surface,
      label: value.label,
      description: value.description,
      required: true,
      when: value.timing === "run_start" ? "run_start" : value.timing === "before_action" ? "before_send" : "before_step",
    }));

  const graph = loopAgentGraphSchema.parse({
    parent: {
      id: "parent_agent",
      name: "Tallei Agent",
      task: `Orchestrate the declared plan: ${ir.summary}`,
      policy: "Execute only the compiled nodes, bindings, checkpoints, and approvals declared by the reviewed planning IR.",
      connectorHub: {
        provider: "composio",
        label: "Composio",
        description: "Connector hub for exact selected external actions.",
      },
    },
    children: allNodes,
  });

  return {
    ok: true,
    compiled: {
      graph,
      inputRequirements,
      connectorPolicy: { allowedReadActions: readActions, allowedWriteActions: writeActions },
    },
  };
}

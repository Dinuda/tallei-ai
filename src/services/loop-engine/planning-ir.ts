import { z } from "zod";
import { inputSurfaceAcceptsValueType, type InputSurface } from "./input-surfaces.js";
import type { ConnectorActionRisk } from "./spec-contracts.js";
import { LOOP_DEFINITION_VERSION, type LoopDefinition } from "../loop-executor/types.js";
import { canonicalToolRef, parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";

const jsonPathSchema = z.string().min(1);

const bindingSchema = z.object({
  source: z.object({
    kind: z.enum(["agent_output", "required_value", "connector_output"]),
    nodeId: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    path: jsonPathSchema.default("/"),
  }),
  targetPath: jsonPathSchema,
  required: z.boolean().default(true),
  valuePolicy: z.enum(["derivable", "passthrough"]).default("derivable"),
  provenance: z.string().optional(),
});

const outputArtifactSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  representation: z.enum(["text", "json"]),
  visibility: z.enum(["internal", "operator"]),
  rendererRef: z.string().nullable().optional(),
  reviewMode: z.enum(["none", "required"]),
  editable: z.boolean(),
  fields: z.array(z.object({
    path: jsonPathSchema,
    type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
    required: z.boolean().default(false),
  })).default([]),
});

export const loopPlanningIRSchema = z.object({
  version: z.literal("v2"),
  title: z.string().min(1),
  summary: z.string().min(1),
  strategy: z.string().min(1),
  schedule: z.object({ cron: z.string().min(1), timezone: z.string().min(1) }),
  requiredValues: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    lifecycle: z.string().min(1),
    timing: z.string().min(1),
    sensitivity: z.string().min(1),
    surface: z.string().min(1),
    valueType: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
    sourceKind: z.string().min(1),
    status: z.string().min(1),
    stableScalar: z.unknown().optional(),
  })).default([]),
  semanticAgents: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    responsibility: z.string().min(1),
    task: z.string().min(1),
    toolRef: z.string().min(1),
    inputBindings: z.array(bindingSchema).default([]),
    outputArtifact: outputArtifactSchema,
  })).default([]),
  selectedActions: z.array(z.object({
    id: z.string().min(1),
    contractRef: z.string().min(1),
    purpose: z.string().min(1),
    annotation: z.object({
      effect: z.string().min(1),
      confidence: z.string().min(1),
      approvalRequired: z.boolean(),
    }),
    bindings: z.array(bindingSchema).default([]),
  })).default([]),
  unresolvedIssues: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    message: z.string().min(1),
    blocksApproval: z.boolean().default(false),
    relatedRef: z.string().nullable().optional(),
  })).default([]),
});

export type LoopPlanningIR = z.infer<typeof loopPlanningIRSchema>;

export type PlanningIRIssue = {
  code: string;
  message: string;
};

type CompileInput = {
  planningIR: LoopPlanningIR;
  contracts: ToolContract[];
};

type SourceEntry = {
  type: string;
  validPaths: string[];
  pathTypes: Map<string, string>;
  representation?: "text" | "json";
};

type CompileResult =
  | { ok: true; compiled: LoopDefinition & { operatorInteractionPlan: { items: unknown[]; interactions: Array<{ kind: string }> } } }
  | { ok: false; issues: PlanningIRIssue[] };

function issue(code: string, message: string): PlanningIRIssue {
  return { code, message };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function propertySchema(schema: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const key = path.replace(/^\//, "");
  const properties = asObject(schema.properties);
  return asObject(properties[key]) || null;
}

function schemaType(schema: Record<string, unknown> | null | undefined): string {
  const type = schema?.type;
  return typeof type === "string" ? type : "unknown";
}

function directSchemaPaths(schema: Record<string, unknown>): string[] {
  return ["/", ...Object.keys(asObject(schema.properties)).map((key) => `/${key}`)].sort((a, b) => {
    if (a === "/") return -1;
    if (b === "/") return 1;
    return a.localeCompare(b);
  });
}

function validJsonPointer(path: string): boolean {
  return path === "/" || /^\/[^./]+(\/[^./]+)*$/.test(path);
}

function correctedPointer(path: string): string {
  return path.replace(/\./g, "/");
}

function firstIssue(issues: PlanningIRIssue[]): CompileResult | null {
  return issues.length > 0 ? { ok: false, issues } : null;
}

function artifactSchema(artifact: LoopPlanningIR["semanticAgents"][number]["outputArtifact"]): Record<string, unknown> {
  if (artifact.representation === "text") {
    return { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of artifact.fields) {
    const key = field.path.replace(/^\//, "");
    if (!key || key.includes("/")) continue;
    properties[key] = field.type === "array" ? { type: "array", items: {} } : { type: field.type };
    if (field.required) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function buildSourceIndex(ir: LoopPlanningIR, contractByRef: Map<string, ToolContract>): Map<string, SourceEntry> {
  const index = new Map<string, SourceEntry>();
  for (const value of ir.requiredValues) {
    index.set(`required_value:${value.key}`, {
      type: value.valueType,
      validPaths: ["/"],
      pathTypes: new Map([["/", value.valueType]]),
    });
  }
  for (const agent of ir.semanticAgents) {
    const paths = agent.outputArtifact.representation === "json"
      ? ["/", ...agent.outputArtifact.fields.map((field) => field.path)].sort((a, b) => {
        if (a === "/") return -1;
        if (b === "/") return 1;
        return a.localeCompare(b);
      })
      : ["/", "/text"];
    const pathTypes = new Map<string, string>([["/", "object"]]);
    if (agent.outputArtifact.representation === "text") {
      pathTypes.set("/text", "string");
    } else {
      for (const field of agent.outputArtifact.fields) pathTypes.set(field.path, field.type);
    }
    index.set(`agent_output:${agent.id}`, {
      type: "object",
      validPaths: paths,
      pathTypes,
      representation: agent.outputArtifact.representation,
    });
  }
  for (const action of ir.selectedActions) {
    const contract = contractByRef.get(canonicalToolRef(action.contractRef));
    if (!contract) continue;
    const paths = directSchemaPaths(contract.outputSchema);
    const pathTypes = new Map<string, string>([["/", "object"]]);
    for (const path of paths) {
      if (path === "/") continue;
      pathTypes.set(path, schemaType(propertySchema(contract.outputSchema, path)));
    }
    index.set(`connector_output:${action.id}`, {
      type: "object",
      validPaths: paths,
      pathTypes,
    });
  }
  return index;
}

function sourceKey(binding: z.infer<typeof bindingSchema>): string | null {
  if (binding.source.kind === "required_value" && binding.source.key) return `required_value:${binding.source.key}`;
  if (binding.source.kind === "agent_output" && binding.source.nodeId) return `agent_output:${binding.source.nodeId}`;
  if (binding.source.kind === "connector_output" && binding.source.nodeId) return `connector_output:${binding.source.nodeId}`;
  return null;
}

function validPathList(entry: SourceEntry | undefined): string {
  return entry?.validPaths.join(", ") ?? "/";
}

function validateBindings(ir: LoopPlanningIR, contracts: ToolContract[], contractByRef: Map<string, ToolContract>): PlanningIRIssue[] {
  const issues: PlanningIRIssue[] = [];
  const sources = buildSourceIndex(ir, contractByRef);

  for (const value of ir.requiredValues) {
    if (!inputSurfaceAcceptsValueType(value.surface as InputSurface, value.valueType)) {
      issues.push(issue("input_surface_type_mismatch", `${value.surface} cannot collect ${value.valueType} values for ${value.key}.`));
    }
  }

  for (const action of ir.selectedActions) {
    if (!contractByRef.has(canonicalToolRef(action.contractRef))) {
      issues.push(issue("unknown_action", `No exact contract is registered for ${action.contractRef}.`));
    }
  }
  if (issues.length > 0) return issues;

  const consumedRequiredValues = new Set<string>();
  const allBindings = [
    ...ir.semanticAgents.flatMap((agent) => agent.inputBindings),
    ...ir.selectedActions.flatMap((action) => action.bindings),
  ];

  for (const binding of allBindings) {
    if (!validJsonPointer(binding.source.path)) {
      issues.push(issue("invalid_source_path_syntax", `Source path ${binding.source.path} must be a JSON pointer such as ${correctedPointer(binding.source.path)}.`));
      continue;
    }
    if (binding.source.kind === "connector_output" && binding.source.path.startsWith("/input/")) {
      issues.push(issue("connector_input_path_used_as_source", `Connector node input path ${binding.source.path} cannot be used as a source.`));
      continue;
    }
    if (binding.source.kind === "required_value" && binding.source.key) consumedRequiredValues.add(binding.source.key);

    const key = sourceKey(binding);
    const source = key ? sources.get(key) : undefined;
    if (!source) continue;
    if (!source.validPaths.includes(binding.source.path)) {
      if (binding.source.kind === "connector_output") {
        issues.push(issue(
          "opaque_connector_output_path",
          `Connector output ${binding.source.path} is not declared; source only exposes: ${validPathList(source)}. Prefer a single direct send action when the draft id is opaque.`,
        ));
      } else {
        const nodeId = binding.source.nodeId ?? binding.source.key ?? "source";
        issues.push(issue("unknown_source_path", `Unknown source path ${binding.source.path}. Valid source paths for ${nodeId}: ${validPathList(source)}.`));
      }
      continue;
    }
    if (source.representation === "text" && binding.source.path !== "/" && binding.source.path !== "/text") {
      issues.push(issue("text_artifact_needs_json_fields", `Text artifacts cannot bind ${binding.source.path}; declare a json outputArtifact with an explicit ${binding.source.path} field.`));
    }
    if (binding.valuePolicy === "passthrough" && binding.source.kind === "agent_output") {
      issues.push(issue("generated_passthrough", `Agent-generated value ${binding.source.path} cannot be marked passthrough.`));
    }
  }

  for (const action of ir.selectedActions) {
    const contract = contractByRef.get(canonicalToolRef(action.contractRef));
    if (!contract) continue;
    const required = Array.isArray(contract.inputSchema.required)
      ? contract.inputSchema.required.filter((value): value is string => typeof value === "string")
      : [];
    const targetPaths = new Set(action.bindings.map((binding) => binding.targetPath));
    for (const key of required) {
      if (!targetPaths.has(`/${key}`)) {
        issues.push(issue("missing_required_binding", `Action ${action.id} is missing required binding /${key}.`));
      }
    }
  }

  for (const value of ir.requiredValues) {
    if (value.key === "timezone" && value.lifecycle === "workflow_config") continue;
    const usedByAgent = ir.semanticAgents.some((agent) =>
      agent.inputBindings.some((binding) => binding.source.kind === "required_value" && binding.source.key === value.key),
    );
    if (!consumedRequiredValues.has(value.key) && !usedByAgent) {
      issues.push(issue("unused_required_value", `Required value ${value.key} is unused. Remove it from requiredValues; do not invent a consumer.`));
    }
  }

  for (const action of ir.selectedActions) {
    const contract = contractByRef.get(canonicalToolRef(action.contractRef));
    if (!contract) continue;
    for (const binding of action.bindings) {
      const key = sourceKey(binding);
      const source = key ? sources.get(key) : undefined;
      if (!source || !source.validPaths.includes(binding.source.path)) continue;
      const sourceType = source.pathTypes.get(binding.source.path) ?? source.type;
      const targetType = schemaType(propertySchema(contract.inputSchema, binding.targetPath));
      if (sourceType !== "unknown" && targetType !== "unknown" && sourceType !== targetType) {
        issues.push(issue("incompatible_binding", `Binding source ${binding.source.path} is ${sourceType}, target ${binding.targetPath} requires ${targetType}.`));
      }
    }
  }

  const textArtifactWithFieldBindings = ir.semanticAgents.some((agent) =>
    agent.outputArtifact.representation === "text"
    && ir.selectedActions.some((action) => action.bindings.some((binding) =>
      binding.source.kind === "agent_output"
      && binding.source.nodeId === agent.id
      && binding.source.path !== "/"
      && binding.source.path !== "/text",
    )),
  );
  if (textArtifactWithFieldBindings) {
    issues.push(issue("text_artifact_needs_json_fields", "Connector bindings need structured content; declare a json outputArtifact with an explicit /subject field."));
  }

  return issues;
}

function contractPolicyFor(contract: ToolContract): { toolkit: string; actionSlug: string; risk: ConnectorActionRisk; requiresPreSendApproval: boolean } | null {
  const parsed = parseConnectorActionToolRef(contract.toolRef);
  if (!parsed) return null;
  const rawRisk = String(contract.constraints.risk ?? (contract.effect === "read_external" ? "read" : "write")).toLowerCase();
  const risk: ConnectorActionRisk = rawRisk === "read" || rawRisk === "write" || rawRisk === "send" || rawRisk === "destructive"
    ? rawRisk
    : contract.effect === "read_external" ? "read" : "write";
  return {
    toolkit: parsed.toolkit,
    actionSlug: parsed.actionSlug.toUpperCase(),
    risk,
    requiresPreSendApproval: contract.effect !== "read_external",
  };
}

function buildCompiledDefinition(ir: LoopPlanningIR, contractByRef: Map<string, ToolContract>): CompileResult {
  const connectorPolicy = { allowedReadActions: [] as unknown[], allowedWriteActions: [] as unknown[] };
  const actionNodes = ir.selectedActions.map((action) => {
    const contract = contractByRef.get(canonicalToolRef(action.contractRef))!;
    const policy = contractPolicyFor(contract);
    if (policy) {
      if (contract.effect === "read_external") connectorPolicy.allowedReadActions.push(policy);
      else connectorPolicy.allowedWriteActions.push(policy);
    }
    return {
      id: action.id,
      name: action.purpose,
      nodeKind: "action" as const,
      task: action.purpose,
      goal: action.purpose,
      tools: [{ ref: contract.toolRef }],
      handoffBindings: [],
    };
  });

  const agentNodes = ir.semanticAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    nodeKind: "agent" as const,
    task: agent.task,
    goal: agent.responsibility,
    tools: agent.toolRef === "internal.llm_only" ? [{ ref: "internal.llm_only" }] : [{ ref: canonicalToolRef(agent.toolRef) }],
    outputArtifactId: agent.outputArtifact.id,
    outputContract: {
      description: agent.outputArtifact.description,
      representation: agent.outputArtifact.representation,
      visibility: agent.outputArtifact.visibility,
      renderer: agent.outputArtifact.rendererRef ?? undefined,
      schema: artifactSchema(agent.outputArtifact),
    },
    handoffBindings: agent.inputBindings.map((binding) => ({
      source: {
        kind: binding.source.kind === "required_value" ? "operator_input" as const : binding.source.kind,
        agentId: binding.source.nodeId,
        key: binding.source.key,
        path: binding.source.path,
      },
      targetPath: binding.targetPath,
      required: binding.required,
      valuePolicy: binding.valuePolicy,
      provenance: binding.provenance as never,
    })),
  }));

  const inputRequirements = ir.requiredValues
    .filter((value) => !(value.key === "timezone" && value.lifecycle === "workflow_config"))
    .map((value) => ({
      key: value.key,
      surface: value.surface,
      label: value.label,
      description: value.description,
      required: true,
      when: value.timing === "before_action" ? "before_send" : "run_start",
    }));

  const interactions = [
    ...inputRequirements.map((req) => ({ id: `collect_${req.key}`, kind: "collect_input", prompt: req.label })),
    ...ir.semanticAgents
      .filter((agent) => agent.outputArtifact.reviewMode === "required")
      .map((agent) => ({ id: `review_${agent.outputArtifact.id}`, kind: "review_artifact", stepId: agent.id })),
    ...ir.selectedActions.map((action) => ({ id: `connect_${action.id}`, kind: "connect_connector", stepId: action.id })),
    ...ir.selectedActions
      .filter((action) => action.annotation.approvalRequired)
      .map((action) => ({ id: `confirm_${action.id}`, kind: "confirm_action", stepId: action.id })),
  ];

  const graph = {
    parent: {
      id: "orchestrator",
      name: "Orchestrator",
      task: ir.strategy,
      policy: "Follow the compiled planning IR and declared handoff contracts.",
    },
    children: [...agentNodes, ...actionNodes],
  };
  const parsed = {
    definitionVersion: LOOP_DEFINITION_VERSION,
    goal: ir.summary,
    schedule: ir.schedule,
    allowedIntegrations: ["internal", "composio"],
    allowedToolRefs: [
      ...new Set([
        ...ir.semanticAgents.map((agent) => canonicalToolRef(agent.toolRef)),
        ...ir.selectedActions.map((action) => canonicalToolRef(action.contractRef)),
      ]),
    ],
    connectorPolicy,
    inputRequirements,
    operatorInteractionPlan: { items: interactions },
    agentGraph: graph,
    graph,
    builderMeta: {
      designedBy: "loop_architect" as const,
      preApproved: true,
      planningIRVersion: ir.version,
      planningIR: ir as unknown as Record<string, unknown>,
    },
  };
  const definition = parsed as unknown as LoopDefinition & { operatorInteractionPlan: { items: unknown[]; interactions: Array<{ kind: string }> } };
  definition.operatorInteractionPlan.interactions = interactions;
  return { ok: true, compiled: definition };
}

export function compileLoopPlanningIR(input: CompileInput): CompileResult {
  const contractByRef = new Map<string, ToolContract>();
  for (const contract of input.contracts) {
    contractByRef.set(canonicalToolRef(contract.toolRef), contract);
  }

  const issues = validateBindings(input.planningIR, input.contracts, contractByRef);
  const failed = firstIssue(issues);
  if (failed) return failed;
  return buildCompiledDefinition(input.planningIR, contractByRef);
}

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  canonicalizeInputRequirementsList,
  dataInputSurfaceSchema,
  defaultLabelForKey,
  inputSurfaceAcceptsValueType,
  type DataInputSurface,
  type InputRequirement,
  type InputRequirementContext,
  type InputSurface,
} from "./input-surfaces.js";
import {
  loopAgentGraphSchema,
  type AgentHandoffBinding,
  type LoopAgentGraph,
} from "../loop-executor/types.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { OperatorInteractionPlan, OperatorInteractionPlanItem } from "./operator-interactions.js";

const jsonValueTypeSchema = z.enum(["string", "number", "integer", "boolean", "object", "array"]);
const sourceKindSchema = z.enum([
  "agent_output",
  "operator_input",
  "stable_config",
  "artifact",
  "connector_output",
]);

const plannedRequiredValueSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  lifecycle: z.enum(["workflow_config", "runtime_input", "derived"]),
  timing: z.enum(["run_start", "before_step", "before_action"]),
  sensitivity: z.enum(["public", "private", "secret"]),
  valueType: jsonValueTypeSchema,
  surface: dataInputSurfaceSchema,
  sourceKind: sourceKindSchema,
  status: z.enum(["resolved", "unresolved"]),
  stableScalar: z.union([z.string(), z.number(), z.boolean()]).nullable().default(null),
});

const plannedBindingSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_output"), nodeId: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("connector_output"), nodeId: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("required_value"), key: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("artifact"), key: z.string().min(1), path: z.string().min(1) }),
]);

const explicitActionInputBindingSchema = z.object({
  source: plannedBindingSourceSchema,
  targetPath: z.string().min(1),
  required: z.boolean(),
  valuePolicy: z.enum(["derivable", "passthrough"]),
  provenance: z.enum(["agent_output", "operator_input", "stable_config", "artifact", "connector_output"]),
});

const plannedArtifactFieldSchema = z.object({
  path: z.string().startsWith("/"),
  type: jsonValueTypeSchema,
  required: z.boolean(),
});

const plannedArtifactSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  representation: z.enum(["text", "json"]),
  visibility: z.enum(["internal", "operator"]),
  rendererRef: z.string().min(1).nullable(),
  reviewMode: z.enum(["none", "required"]),
  editable: z.boolean(),
  fields: z.array(plannedArtifactFieldSchema).max(32),
});

const semanticAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  responsibility: z.string().min(1),
  task: z.string().min(1),
  toolRef: z.string().min(1),
  inputBindings: z.array(explicitActionInputBindingSchema),
  outputArtifact: plannedArtifactSchema,
});

const actionSemanticAnnotationSchema = z.object({
  effect: z.enum(["read_external", "write_external", "irreversible_external", "uncertain"]),
  confidence: z.enum(["low", "medium", "high"]),
  approvalRequired: z.boolean(),
});

const selectedConnectorActionSchema = z.object({
  id: z.string().min(1),
  contractRef: z.string().min(1),
  purpose: z.string().min(1),
  annotation: actionSemanticAnnotationSchema,
  bindings: z.array(explicitActionInputBindingSchema),
});

const unresolvedPlanningIssueSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["decision", "required_value", "action", "binding", "contract"]),
  message: z.string().min(1),
  blocksApproval: z.boolean(),
  relatedRef: z.string().min(1).nullable().default(null),
});

export const loopPlanningIRSchema = z.object({
  version: z.literal("v2"),
  title: z.string().min(1),
  summary: z.string().min(1),
  strategy: z.string().min(1),
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }),
  requiredValues: z.array(plannedRequiredValueSchema),
  semanticAgents: z.array(semanticAgentSchema).max(12),
  selectedActions: z.array(selectedConnectorActionSchema),
  unresolvedIssues: z.array(unresolvedPlanningIssueSchema),
});

function makePlannerJsonSchemaStrict(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(makePlannerJsonSchemaStrict);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(row).map(([key, entry]) => [
    key,
    makePlannerJsonSchemaStrict(entry),
  ]));
  delete result.default;
  delete result.$schema;
  return result;
}

export const loopPlanningIRJsonSchema = makePlannerJsonSchemaStrict(zodToJsonSchema(loopPlanningIRSchema, {
  target: "openAi",
  $refStrategy: "none",
})) as Record<string, unknown>;

function arraySchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected planner array schema");
  const schema = value as Record<string, unknown>;
  if (schema.type === "array") return schema;
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const arrayVariant = variants.find((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).type === "array");
  if (!arrayVariant || typeof arrayVariant !== "object" || Array.isArray(arrayVariant)) {
    throw new Error("Expected planner array schema variant");
  }
  return arrayVariant as Record<string, unknown>;
}

function objectProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected planner object schema");
  const properties = (value as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Expected planner object properties");
  }
  return properties as Record<string, unknown>;
}

export function loopPlanningIRJsonSchemaForContracts(input: {
  internalToolRefs: string[];
  connectorContractRefs: string[];
}): Record<string, unknown> {
  const schema = structuredClone(loopPlanningIRJsonSchema);
  const rootProperties = objectProperties(schema);
  const semanticAgents = arraySchema(rootProperties.semanticAgents);
  const internalRefs = [...new Set(input.internalToolRefs)];
  if (internalRefs.length === 0) {
    semanticAgents.maxItems = 0;
  } else {
    const semanticAgentProperties = objectProperties(semanticAgents.items);
    semanticAgentProperties.toolRef = { type: "string", enum: internalRefs };
  }

  const selectedActions = arraySchema(rootProperties.selectedActions);
  const connectorRefs = [...new Set(input.connectorContractRefs)];
  if (connectorRefs.length === 0) {
    selectedActions.maxItems = 0;
  } else {
    const selectedActionProperties = objectProperties(selectedActions.items);
    selectedActionProperties.contractRef = { type: "string", enum: connectorRefs };
  }
  return schema;
}

export type LoopPlanningIR = z.infer<typeof loopPlanningIRSchema>;
type LoopPlanningIRV2 = LoopPlanningIR;
type PlannedRequiredValue = z.infer<typeof plannedRequiredValueSchema>;
type ExplicitActionInputBinding = z.infer<typeof explicitActionInputBindingSchema>;
type ExplicitBindingRef = ExplicitActionInputBinding;
type SelectedConnectorAction = z.infer<typeof selectedConnectorActionSchema>;
type SelectedContractRef = SelectedConnectorAction;
type UnresolvedPlanningIssue = z.infer<typeof unresolvedPlanningIssueSchema>;
type PlannedArtifact = z.infer<typeof plannedArtifactSchema>;

export type PlanningCompilationIssue = {
  code: string;
  message: string;
  path?: string;
};

type CompiledLoopPlanningIR = {
  graph: LoopAgentGraph;
  inputRequirements: InputRequirement[];
  connectorPolicy: {
    allowedReadActions: Array<{ toolkit: string; actionSlug: string; risk: "read"; description: string; requiresPreSendApproval: false }>;
    allowedWriteActions: Array<{ toolkit: string; actionSlug: string; risk: "write" | "destructive"; description: string; requiresPreSendApproval: true }>;
  };
  operatorInteractionPlan: OperatorInteractionPlan;
};

function schemaForType(type: z.infer<typeof jsonValueTypeSchema>): Record<string, unknown> {
  if (type === "array") return { type: "array", items: {} };
  if (type === "object") return { type: "object", properties: {}, additionalProperties: false };
  return { type };
}

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

function ensureObjectNode(node: Record<string, unknown>): Record<string, unknown> {
  if (node.type === "array") return ensureObjectNode(node.items as Record<string, unknown>);
  if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) {
    node.type = "object";
    node.properties = {};
    if (!Array.isArray(node.required)) node.required = [];
    if (node.additionalProperties === undefined) node.additionalProperties = false;
  }
  return node;
}

function ensureArrayNode(node: Record<string, unknown>): Record<string, unknown> {
  if (node.type !== "array") {
    node.type = "array";
    node.items = emptyObjectSchema();
    delete node.properties;
    delete node.required;
  } else if (!node.items || typeof node.items !== "object" || Array.isArray(node.items)) {
    node.items = emptyObjectSchema();
  }
  return node;
}

function childObjectSchema(existing: unknown): Record<string, unknown> {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return emptyObjectSchema();
  const node = existing as Record<string, unknown>;
  if (node.type === "object") return ensureObjectNode(node);
  if (node.type === "array") return ensureArrayNode(node);
  return emptyObjectSchema();
}

function setSchemaAtPath(
  root: Record<string, unknown>,
  path: string,
  schema: Record<string, unknown>,
  required: boolean,
): void {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return;
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (/^\d+$/.test(segment)) {
      const arrayNode = ensureArrayNode(current);
      current = ensureObjectNode(arrayNode.items as Record<string, unknown>);
      continue;
    }
    const objectNode = ensureObjectNode(current);
    const properties = objectNode.properties as Record<string, unknown>;
    properties[segment] = childObjectSchema(properties[segment]);
    current = properties[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  if (/^\d+$/.test(leaf)) {
    ensureArrayNode(current).items = schema;
    return;
  }
  const objectNode = ensureObjectNode(current);
  const properties = objectNode.properties as Record<string, unknown>;
  properties[leaf] = schema;
  if (required) {
    const requiredFields = new Set(Array.isArray(objectNode.required) ? objectNode.required as string[] : []);
    requiredFields.add(leaf);
    objectNode.required = [...requiredFields];
  }
}

function schemaFromFields(fields: PlannedArtifact["fields"]): Record<string, unknown> {
  const root: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  for (const field of fields) {
    setSchemaAtPath(root, field.path, schemaForType(field.type), field.required);
  }
  return root;
}

function artifactContract(artifact: PlannedArtifact) {
  const fields = artifact.representation === "text"
    ? [{ path: "/text", type: "string" as const, required: true }]
    : artifact.fields;
  return {
    description: artifact.description,
    schema: schemaFromFields(fields),
    representation: artifact.representation,
    mediaType: artifact.representation === "json" ? "application/json" as const : "text/plain" as const,
    visibility: artifact.visibility,
    ...(artifact.rendererRef ? { renderer: artifact.rendererRef } : {}),
  };
}

function requiredValueSchema(value: PlannedRequiredValue): Record<string, unknown> {
  return schemaForType(value.valueType);
}

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

export function schemaAddressablePaths(schema: Record<string, unknown>, base = ""): string[] {
  const paths = new Set<string>(["/"]);
  const visit = (node: Record<string, unknown>, path: string): void => {
    if (path) paths.add(path);
    if (node.type === "array") {
      const items = node.items;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        visit(items as Record<string, unknown>, path);
      }
      return;
    }
    const properties = node.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      visit(value as Record<string, unknown>, `${path}/${key}`);
    }
  };
  visit(schema, base);
  return [...paths].sort();
}

function formatAvailablePaths(paths: string[]): string {
  if (paths.length === 0) return "none";
  return paths.slice(0, 24).join(", ");
}

function bindingPathUsesDotNotation(path: string): boolean {
  return path.split("/").filter(Boolean).some((segment) => segment.includes("."));
}

function normalizeBindingPathSyntax(path: string): string {
  if (path === "/") return path;
  const segments = path.split("/").filter(Boolean);
  return `/${segments.flatMap((segment) => segment.split(".").filter(Boolean)).join("/")}`;
}

function longestDeclaredSourcePrefix(
  schema: Record<string, unknown> | undefined,
  path: string,
): string | null {
  if (!schema) return null;
  const normalized = normalizeBindingPathSyntax(path);
  const segments = normalized.split("/").filter(Boolean);
  let current: Record<string, unknown> | null = schema;
  let lastValid = "/";
  for (const segment of segments) {
    if (!current) break;
    const next = schemaAtPath(current, `/${segment}`);
    if (!next) break;
    lastValid = lastValid === "/" ? `/${segment}` : `${lastValid}/${segment}`;
    current = next;
  }
  return lastValid;
}

function schemaTypeSummary(schema: Record<string, unknown> | null | undefined): string {
  if (!schema) return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.filter((value): value is string => typeof value === "string").join("|");
  return "unspecified";
}

function schemasCompatible(source: Record<string, unknown>, target: Record<string, unknown>): boolean {
  const sourceType = typeof source.type === "string" ? source.type : null;
  const targetType = typeof target.type === "string" ? target.type : null;
  if (!sourceType || !targetType) return true;
  if (sourceType === targetType) return true;
  if (
    (sourceType === "integer" || sourceType === "number")
    && (targetType === "integer" || targetType === "number")
  ) {
    return true;
  }
  // Operator contact lists are supplied as CSV text and normalized to arrays at runtime.
  if (sourceType === "string" && targetType === "array") return true;
  if (sourceType === "array" && targetType === "string") return true;
  return false;
}

function shouldSeedRequiredValueFromSpec(surface: InputSurface): surface is DataInputSurface {
  return surface.startsWith("input.");
}

function valueTypeForSurface(surface: InputSurface): z.infer<typeof jsonValueTypeSchema> {
  if (surface === "input.contacts_csv") return "array";
  if (surface === "input.file") return "string";
  return "string";
}

function timingForSeededRequirement(req: InputRequirement): PlannedRequiredValue["timing"] {
  if (req.surface === "confirm.send") return "before_action";
  if (req.when === "before_send") return "before_action";
  if (req.when === "before_step") return "before_step";
  return "run_start";
}

function sensitivityForSeededRequirement(req: InputRequirement): PlannedRequiredValue["sensitivity"] {
  if (req.surface === "input.contacts_csv" || req.surface === "input.audience_id") return "private";
  return "public";
}

function lifecycleForSeededRequirement(req: InputRequirement): PlannedRequiredValue["lifecycle"] {
  if (req.surface === "input.contacts_csv" || req.surface === "input.audience_id") {
    return "workflow_config";
  }
  if (req.when === "before_step" || req.when === "before_send") {
    return "runtime_input";
  }
  return "workflow_config";
}

function sourceKindForLifecycle(lifecycle: PlannedRequiredValue["lifecycle"]): PlannedRequiredValue["sourceKind"] {
  if (lifecycle === "workflow_config") return "stable_config";
  if (lifecycle === "runtime_input") return "operator_input";
  return "agent_output";
}

function normalizeRequiredValueSourceKinds(values: PlannedRequiredValue[]): PlannedRequiredValue[] {
  return values.map((value) => {
    const expected = sourceKindForLifecycle(value.lifecycle);
    return value.sourceKind === expected ? value : { ...value, sourceKind: expected };
  });
}

const SCHEDULE_OWNED_REQUIRED_VALUE_KEYS = new Set(["timezone", "cron"]);

/** cron and timezone are owned by planningIR.schedule, not requiredValues. */
function stripScheduleOwnedRequiredValues(values: PlannedRequiredValue[]): PlannedRequiredValue[] {
  return values.filter((value) => !SCHEDULE_OWNED_REQUIRED_VALUE_KEYS.has(value.key));
}

export function seedRequiredValuesFromSpec(requirements: InputRequirement[]): PlannedRequiredValue[] {
  return requirements.flatMap((req) => {
    if (!shouldSeedRequiredValueFromSpec(req.surface)) return [];
    const lifecycle = lifecycleForSeededRequirement(req);
    return [{
      key: req.key,
      label: req.label ?? defaultLabelForKey(req.key),
      description: req.description ?? (lifecycle === "workflow_config"
        ? `Build-time configuration for ${req.key}.`
        : `Runtime value for ${req.key}.`),
      lifecycle,
      timing: timingForSeededRequirement(req),
      sensitivity: sensitivityForSeededRequirement(req),
      valueType: valueTypeForSurface(req.surface),
      surface: req.surface,
      sourceKind: sourceKindForLifecycle(lifecycle),
      status: "resolved" as const,
      stableScalar: null,
    }];
  });
}

export function mergeCompiledInputRequirementsWithSpec(input: {
  compiled: InputRequirement[];
  specRequirements: InputRequirement[];
  context: InputRequirementContext;
}): InputRequirement[] {
  return canonicalizeInputRequirementsList(
    [...input.compiled, ...input.specRequirements],
    input.context,
  );
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
  textArtifactProducers: Map<string, PlannedArtifact>;
  artifactIdToAgentId: Map<string, string>;
  issues: PlanningCompilationIssue[];
}): void {
  const { binding, owner, targetSchema, outputSchemas, requiredValues, textArtifactProducers, artifactIdToAgentId, issues } = input;
  const target = schemaAtPath(targetSchema, binding.targetPath);
  if (!target) {
    issues.push({
      code: "unknown_target_path",
      message: `${owner} binding targets a path absent from its exact input contract: ${binding.targetPath}. Valid target paths: ${formatAvailablePaths(schemaAddressablePaths(targetSchema))}.`,
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
    if (value.sourceKind !== binding.provenance) {
      issues.push({
        code: "required_value_source_policy",
        message: `${owner} binding ${binding.targetPath} violates required value ${value.key} source policy. lifecycle ${value.lifecycle} requires sourceKind ${expectedProvenance ?? value.sourceKind} and binding provenance ${expectedProvenance ?? binding.provenance}.`,
        path: owner,
      });
    }
    sourceSchema = requiredValueSchema(value);
  } else if (binding.source.kind === "agent_output" || binding.source.kind === "connector_output") {
    const producerArtifact = binding.source.nodeId
      ? textArtifactProducers.get(binding.source.nodeId)
      : undefined;
    if (
      producerArtifact?.representation === "text"
      && binding.source.path !== "/"
      && binding.source.path !== "/text"
    ) {
      issues.push({
        code: "text_artifact_needs_json_fields",
        message: `${binding.source.nodeId} is a text artifact exposing only /text. Binding ${binding.source.path} requires changing outputArtifact to representation json with an explicit ${binding.source.path} field, or rebind to /text.`,
        path: binding.source.nodeId ?? owner,
      });
      return;
    }
    const declaredPath = binding.source.path;
    const normalizedPath = normalizeBindingPathSyntax(declaredPath);
    if (bindingPathUsesDotNotation(declaredPath)) {
      issues.push({
        code: "invalid_source_path_syntax",
        message: `${owner} binding source path ${declaredPath} uses dot notation. Connector and agent output paths must use slash-separated JSON pointer segments such as ${normalizedPath}.`,
        path: owner,
      });
      return;
    }
    const firstSegment = normalizedPath.split("/").filter(Boolean)[0] ?? "";
    if (firstSegment === "input") {
      issues.push({
        code: "connector_input_path_used_as_source",
        message: `${owner} binding source path ${declaredPath} references the /input sub-object of node ${binding.source.nodeId ?? "unknown"}, which is that node's input schema, not its output. Bind from a semantic agent outputArtifact field or a declared connector outputPaths entry instead.`,
        path: owner,
      });
      return;
    }
    sourceSchema = binding.source.nodeId
      ? schemaAtPath(outputSchemas.get(binding.source.nodeId) ?? {}, normalizedPath)
      : null;
    if (!sourceSchema) {
      const sourceNodeId = binding.source.nodeId;
      const sourceRoot = sourceNodeId ? outputSchemas.get(sourceNodeId) : undefined;
      const validPaths = sourceRoot ? schemaAddressablePaths(sourceRoot) : [];
      const declaredPrefix = longestDeclaredSourcePrefix(sourceRoot, normalizedPath);
      if (
        binding.source.kind === "connector_output"
        && declaredPrefix
        && declaredPrefix !== normalizedPath
        && validPaths.includes(declaredPrefix)
      ) {
        issues.push({
          code: "opaque_connector_output_path",
          message: `${owner} binding source path ${declaredPath} drills into undeclared connector output under ${sourceNodeId}. The exact contract only exposes: ${formatAvailablePaths(validPaths)}. Rebind to one of those exact paths, or replace the multi-action draft chain with a single direct send action whose inputs bind from the semantic agent.`,
          path: sourceNodeId ?? owner,
        });
        return;
      }
      const correctAgentId = sourceNodeId ? artifactIdToAgentId.get(sourceNodeId) : undefined;
      if (sourceRoot === undefined && sourceNodeId && correctAgentId) {
        issues.push({
          code: "artifact_id_used_as_node_id",
          message: `${owner} binding source.nodeId "${sourceNodeId}" is an artifact id, not an agent id. Replace source.nodeId with the producing agent's id: "${correctAgentId}".`,
          path: owner,
        });
        return;
      }
      issues.push({
        code: "unknown_source_path",
        message: `${owner} binding source path does not exist: ${sourceNodeId ?? "unknown"}${declaredPath}. Valid source paths for ${sourceNodeId ?? "unknown"}: ${formatAvailablePaths(validPaths)}.`,
        path: owner,
      });
    }
  }

  if (sourceSchema && target && !schemasCompatible(sourceSchema, target)) {
    issues.push({
      code: "incompatible_binding",
      message: `${owner} binding ${binding.targetPath} has incompatible types: source ${binding.source.path} is ${schemaTypeSummary(sourceSchema)}, target ${binding.targetPath} requires ${schemaTypeSummary(target)}.`,
      path: owner,
    });
  }
}

function stableConfigForBindings(
  bindings: ExplicitActionInputBinding[],
  requiredValues: Map<string, PlannedRequiredValue>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const binding of bindings) {
    if (binding.source.kind !== "required_value" || !binding.source.key) continue;
    const value = requiredValues.get(binding.source.key);
    if (value?.lifecycle === "workflow_config" && value.status === "resolved" && value.stableScalar != null) {
      result[value.key] = value.stableScalar;
    }
  }
  return result;
}

function sourceSchemaForBinding(
  binding: ExplicitActionInputBinding,
  outputSchemas: Map<string, Record<string, unknown>>,
  requiredValues: Map<string, PlannedRequiredValue>,
): Record<string, unknown> {
  if (binding.source.kind === "required_value" && binding.source.key) {
    const value = requiredValues.get(binding.source.key);
    return value ? requiredValueSchema(value) : {};
  }
  if ((binding.source.kind === "agent_output" || binding.source.kind === "connector_output") && binding.source.nodeId) {
    return schemaAtPath(outputSchemas.get(binding.source.nodeId) ?? {}, binding.source.path) ?? {};
  }
  return {};
}

function semanticInputContract(
  agent: LoopPlanningIR["semanticAgents"][number],
  outputSchemas: Map<string, Record<string, unknown>>,
  requiredValues: Map<string, PlannedRequiredValue>,
) {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  for (const binding of agent.inputBindings) {
    setSchemaAtPath(
      schema,
      binding.targetPath,
      sourceSchemaForBinding(binding, outputSchemas, requiredValues),
      binding.required,
    );
  }
  return { description: `Explicit inputs for ${agent.name}`, schema };
}

function compileLoopPlanningIRV2(input: {
  planningIR: LoopPlanningIR;
  contracts: ToolContract[];
  options?: { draftReviewAgentIds?: Set<string> };
}): { ok: true; compiled: CompiledLoopPlanningIR } | { ok: false; issues: PlanningCompilationIssue[] } {
  const parsed = loopPlanningIRSchema.parse(input.planningIR);
  const ir = {
    ...parsed,
    requiredValues: stripScheduleOwnedRequiredValues(
      normalizeRequiredValueSourceKinds(parsed.requiredValues),
    ),
  };
  void input.options;
  const runtimeEdgeCasePattern = /\b(zero|no|empty|0)\b.{0,60}\b(results?|stories|items?|sources?)\b|\bif\b.{0,80}\b(runtime|agent|should|instruct|proceed|abort|expand)\b|\boperator must resolve this at runtime\b/i;
  const issues: PlanningCompilationIssue[] = ir.unresolvedIssues
    .filter((issue) => {
      if (!issue.blocksApproval) return false;
      if (runtimeEdgeCasePattern.test(issue.message)) {
        console.warn(`[planning-ir] Dropping runtime edge-case unresolved issue (should not block planning): ${issue.id}`);
        return false;
      }
      return true;
    })
    .map((issue) => ({
      code: `unresolved_${issue.kind}`,
      message: issue.message,
      ...(issue.relatedRef ? { path: issue.relatedRef } : {}),
    }));
  const requiredValues = new Map(ir.requiredValues.map((value) => [value.key, value]));
  const contracts = new Map(input.contracts.map((contract) => [contract.toolRef.toLowerCase(), contract]));
  const nodeIds = new Set<string>();
  const consumedSemanticOutputs = new Set<string>();
  const consumedRequiredValues = new Set<string>();
  const outputSchemas = new Map(ir.semanticAgents.map((agent) => [agent.id, artifactContract(agent.outputArtifact).schema]));
  const textArtifactProducers = new Map(
    ir.semanticAgents
      .filter((agent) => agent.outputArtifact.representation === "text")
      .map((agent) => [agent.id, agent.outputArtifact]),
  );
  const artifactIdToAgentId = new Map(
    ir.semanticAgents.map((agent) => [agent.outputArtifact.id, agent.id]),
  );
  for (const action of ir.selectedActions) {
    const contract = contracts.get(action.contractRef.toLowerCase());
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
  for (const agent of ir.semanticAgents) {
    if (agent.outputArtifact.representation === "text" && agent.outputArtifact.fields.length > 0) {
      issues.push({
        code: "text_artifact_fields",
        message: `Text artifact ${agent.outputArtifact.id} must declare fields: [] and use the implicit /text output. Change representation to json only when downstream consumers require multiple named fields.`,
        path: agent.id,
      });
    }
    const fieldPaths = new Set<string>();
    for (const field of agent.outputArtifact.fields) {
      if (fieldPaths.has(field.path)) {
        issues.push({
          code: "duplicate_artifact_field",
          message: `Artifact ${agent.outputArtifact.id} declares field ${field.path} more than once.`,
          path: agent.id,
        });
      }
      fieldPaths.add(field.path);
    }
  }

  const semanticChildren = ir.semanticAgents.map((agent) => {
    const inputContract = semanticInputContract(agent, outputSchemas, requiredValues);
    const outputContract = artifactContract(agent.outputArtifact);
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
        targetSchema: inputContract.schema,
        outputSchemas,
        requiredValues,
        textArtifactProducers,
        artifactIdToAgentId,
        issues,
      });
    }
    return {
      id: agent.id,
      name: agent.name,
      nodeKind: "agent" as const,
      task: agent.task,
      goal: agent.responsibility,
      tools: [{
        ref: agent.toolRef,
        ...(Object.keys(stableConfigForBindings(agent.inputBindings, requiredValues)).length > 0
          ? { config: stableConfigForBindings(agent.inputBindings, requiredValues) }
          : {}),
      }],
      doneCriteria: [`${agent.responsibility} is complete.`],
      inputContract,
      outputContract,
      handoffBindings: compileBindings(agent.inputBindings, requiredValues, issues, agent.id),
      ...(agent.outputArtifact.reviewMode === "required" ? {
        gate: { type: "draft_review" as const, question: `Review ${agent.name} output before continuing.` },
      } : {}),
      outputArtifactId: agent.outputArtifact.id,
      outputArtifactKind: "structured_output",
    };
  });

  const readActions: CompiledLoopPlanningIR["connectorPolicy"]["allowedReadActions"] = [];
  const writeActions: CompiledLoopPlanningIR["connectorPolicy"]["allowedWriteActions"] = [];
  const actionChildren = ir.selectedActions.flatMap((action) => {
    if (nodeIds.has(action.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${action.id}`, path: action.id });
    nodeIds.add(action.id);
    const contract = contracts.get(action.contractRef.toLowerCase());
    const parsedRef = parseConnectorActionToolRef(action.contractRef);
    if (!contract || !parsedRef) {
      issues.push({ code: "unknown_action", message: `Selected action has no exact discovered contract: ${action.contractRef}`, path: action.id });
      return [];
    }
    const declaredRisk = String(contract.constraints.risk ?? "").toLowerCase();
    if (declaredRisk && declaredRisk !== "read" && action.annotation.effect === "read_external") {
      issues.push({
        code: "unsafe_risk_annotation",
        message: `${action.contractRef} is not declared read-only by its exact contract and cannot be planned as a read action.`,
        path: action.id,
      });
    }
    for (const binding of action.bindings) {
      if ((binding.source.kind === "agent_output" || binding.source.kind === "connector_output") && binding.source.nodeId) {
        consumedSemanticOutputs.add(binding.source.nodeId);
      }
      if (binding.source.kind === "required_value") {
        if (binding.source.key) consumedRequiredValues.add(binding.source.key);
      }
      validateBinding({
        binding,
        owner: action.contractRef,
        targetSchema: contract.inputSchema,
        outputSchemas,
        requiredValues,
        textArtifactProducers,
        artifactIdToAgentId,
        issues,
      });
    }
    const boundPaths = new Set(action.bindings.map((binding) => binding.targetPath));
    for (const requiredPath of schemaRequiredPaths(contract.inputSchema)) {
      const covered = [...boundPaths].some((boundPath) =>
        boundPath === requiredPath || requiredPath.startsWith(`${boundPath}/`));
      if (!covered) {
        issues.push({
          code: "missing_required_binding",
          message: `${action.contractRef} has no explicit binding for required input ${requiredPath}. Valid target paths: ${formatAvailablePaths(schemaAddressablePaths(contract.inputSchema))}.`,
          path: action.id,
        });
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
    const stableConfig = stableConfigForBindings(action.bindings, requiredValues);
    return [{
      id: action.id,
      name: contract.name,
      nodeKind: "action" as const,
      task: action.purpose,
      goal: action.purpose,
      tools: [{ ref: action.contractRef, ...(Object.keys(stableConfig).length > 0 ? { config: stableConfig } : {}) }],
      doneCriteria: ["The provider reports a successful action result."],
      inputContract: { description: `Exact input contract for ${action.contractRef}`, schema: contract.inputSchema },
      outputContract: {
        description: `Exact output contract for ${action.contractRef}`,
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
    const isOperatorVisibleTerminal = agent.outputArtifact.visibility === "operator";
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
      issues.push({
        code: "unused_required_value",
        message: `Required value ${value.key} has no declared consumer. Remove it from requiredValues; do not invent a consumer.`,
        path: value.key,
      });
    }
  }

  const allNodes = [...semanticChildren, ...actionChildren];
  const nodeOrder = new Map(allNodes.map((node, index) => [node.id, index]));
  for (const [nodeIndex, node] of allNodes.entries()) {
    for (const binding of node.handoffBindings) {
      if (binding.source.kind === "agent_output" && binding.source.agentId && !nodeIds.has(binding.source.agentId)) {
        const correctId = artifactIdToAgentId.get(binding.source.agentId);
        const hint = correctId
          ? ` "${binding.source.agentId}" is an artifact id — use the producing agent's id "${correctId}" as source.nodeId instead.`
          : "";
        issues.push({ code: "unknown_binding_source", message: `${node.id} references unknown source node ${binding.source.agentId}.${hint}`, path: node.id });
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

  const operatorInteractions: OperatorInteractionPlanItem[] = [];
  for (const value of ir.requiredValues.filter((candidate) => candidate.lifecycle === "runtime_input")) {
    const consumer = [
      ...ir.semanticAgents.map((agent) => ({ id: agent.id, bindings: agent.inputBindings })),
      ...ir.selectedActions.map((action) => ({ id: action.id, bindings: action.bindings })),
    ].find((node) => node.bindings.some((binding) =>
      binding.source.kind === "required_value" && binding.source.key === value.key));
    if (!consumer) continue;
    if (!inputSurfaceAcceptsValueType(value.surface, value.valueType)) {
      issues.push({
        code: "input_surface_type_mismatch",
        message: `Input surface ${value.surface} cannot collect ${value.valueType} required value ${value.key}.`,
        path: value.key,
      });
      continue;
    }
    operatorInteractions.push({
      id: `collect:${value.key}`,
      kind: "collect_input",
      requiredValueKey: value.key,
      consumingNodeId: consumer.id,
      surface: value.surface,
      timing: value.timing === "run_start" ? "run_start" : value.timing === "before_action" ? "before_send" : "before_step",
      valueType: value.valueType,
      label: value.label,
      description: value.description,
      required: true,
    });
  }
  for (const agent of ir.semanticAgents.filter((candidate) => candidate.outputArtifact.reviewMode === "required")) {
    if (agent.outputArtifact.visibility !== "operator") {
      issues.push({
        code: "review_artifact_not_operator_visible",
        message: `Reviewed artifact ${agent.outputArtifact.id} must be operator-visible.`,
        path: agent.id,
      });
      continue;
    }
    if (agent.outputArtifact.rendererRef && !["canvas.email", "canvas.preview"].includes(agent.outputArtifact.rendererRef)) {
      issues.push({
        code: "unknown_renderer",
        message: `Reviewed artifact ${agent.outputArtifact.id} uses unknown renderer ${agent.outputArtifact.rendererRef}.`,
        path: agent.id,
      });
      continue;
    }
    operatorInteractions.push({
      id: `review:${agent.outputArtifact.id}`,
      kind: "review_artifact",
      producerNodeId: agent.id,
      artifactId: agent.outputArtifact.id,
      rendererRef: agent.outputArtifact.rendererRef,
      editable: agent.outputArtifact.editable,
      allowedCommands: ["approve", "revise", "reject"],
    });
  }
  for (const action of ir.selectedActions) {
    operatorInteractions.push({
      id: `connect:${action.id}`,
      kind: "connect_connector",
      actionNodeId: action.id,
      contractRef: action.contractRef,
    });
    const uncertain = action.annotation.effect === "uncertain" || action.annotation.confidence === "low";
    const requiresApproval = action.annotation.approvalRequired || uncertain
      || action.annotation.effect === "write_external"
      || action.annotation.effect === "irreversible_external";
    if (requiresApproval) {
      operatorInteractions.push({
        id: `confirm:${action.id}`,
        kind: "confirm_action",
        actionNodeId: action.id,
        contractRef: action.contractRef,
        effect: action.annotation.effect === "read_external" ? "uncertain" : action.annotation.effect,
        approvalRequired: true,
      });
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
      operatorInteractionPlan: { version: "v1", interactions: operatorInteractions },
    },
  };
}

/** Compatibility export for callers that compile the current planning IR version. */
export const compileLoopPlanningIR = compileLoopPlanningIRV2;

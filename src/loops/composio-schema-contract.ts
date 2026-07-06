import type {
  ComposioActionInstruction,
  ComposioActionInputSource,
  ComposioToolContract,
} from "./spec.js";
import { buildComposioActionInstruction } from "./composio-action-instructions.js";
import { summarizeInputSchema } from "./tool-schema.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const HIDDEN_DEFAULTS: Record<string, unknown> = {
  verbose: true,
  include_payload: false,
  includePayload: false,
  include_body: false,
  includeBody: false,
  full_payload: false,
};

const HIDDEN_FIELD_PATTERNS = [
  /^verbose$/i,
  /^include_?payload$/i,
  /^include_?body$/i,
  /^full_?payload$/i,
];

const LIMIT_FIELD_PATTERNS = [
  /^max_?results$/i,
  /^limit$/i,
  /^page_?size$/i,
  /^max_?results_?per_?page$/i,
];

const PLANNABLE_FIELD_PATTERNS = [
  /^body$/i,
  /^subject$/i,
  /^text$/i,
  /^message$/i,
  /^content$/i,
  /^html$/i,
  /^query$/i,
  /^search$/i,
  /^filter$/i,
  /^q$/i,
  /^recipient/i,
  /^to$/i,
  /^cc$/i,
  /^bcc$/i,
  /^name$/i,
  /^title$/i,
  /^description$/i,
  /^note$/i,
  /^comment$/i,
];

function fieldMatches(field: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(field));
}

function isOperationalField(field: string): boolean {
  return fieldMatches(field, HIDDEN_FIELD_PATTERNS) || fieldMatches(field, LIMIT_FIELD_PATTERNS);
}

function isPlannableField(field: string): boolean {
  return fieldMatches(field, PLANNABLE_FIELD_PATTERNS);
}

function fieldLooksLikeIdentifier(field: string): boolean {
  const normalized = field.toLowerCase();
  return normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("id");
}

function defaultForField(field: string): unknown {
  if (field in HIDDEN_DEFAULTS) return HIDDEN_DEFAULTS[field];
  if (fieldMatches(field, LIMIT_FIELD_PATTERNS)) return 1;
  return undefined;
}

export type PriorActionOutput = {
  actionSlug: string;
  outputSchema?: Record<string, unknown>;
};

export type FeasibilityContext = {
  triggerSlug?: string;
  triggerFieldNames?: string[];
  priorActions?: PriorActionOutput[];
};

export type RequiredFieldSummary = {
  field: string;
  type: string;
  description: string;
  source: string;
};

export type ActionFeasibilityResult = {
  feasible: boolean;
  requiredFields: RequiredFieldSummary[];
  unresolvableFields: string[];
  feasibilityReason?: string;
  inputInstructions: ComposioActionInstruction["inputInstructions"];
};

function outputFieldNames(outputSchema?: Record<string, unknown>): string[] {
  const row = asRecord(outputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  return Object.keys(properties).filter((field) => field !== "type" && field !== "required");
}

function priorActionProvidesField(field: string, priorActions: PriorActionOutput[] = []): PriorActionOutput | undefined {
  const normalized = field.toLowerCase();
  return priorActions.find((action) =>
    outputFieldNames(action.outputSchema).some((outputField) =>
      outputField.toLowerCase() === normalized
      || outputField.toLowerCase().replace(/_/g, "") === normalized.replace(/_/g, ""),
    ));
}

function summarizeSource(sources: ComposioActionInputSource[]): string {
  if (sources.length === 0) return "unavailable";
  return sources.map((source) => {
    if (source.type === "trigger") return `trigger.${source.path ?? "?"}`;
    if (source.type === "previous_action") return `previous_action.${source.path ?? "?"}`;
    if (source.type === "planner") return "planner";
    if (source.type === "static") return "static";
    if (source.type === "user_config") return `user_config.${source.path ?? "?"}`;
    return source.type;
  }).join(" | ");
}

function fieldTypeFromSchema(inputSchema: Record<string, unknown>, field: string): string {
  const properties = asRecord(inputSchema.properties) ?? {};
  const prop = asRecord(properties[field]);
  return typeof prop?.type === "string" ? prop.type : "string";
}

function fieldDescriptionFromSchema(inputSchema: Record<string, unknown>, field: string): string {
  const properties = asRecord(inputSchema.properties) ?? {};
  const prop = asRecord(properties[field]);
  return typeof prop?.description === "string" ? prop.description : `Required field ${field}`;
}

export function resolveFieldSources(
  field: string,
  inputSchema: Record<string, unknown>,
  context: FeasibilityContext = {},
): ComposioActionInputSource[] {
  const defaultValue = defaultForField(field);
  if (defaultValue !== undefined) {
    return [{
      type: "static",
      value: defaultValue,
      description: `Runner-controlled default for operational field ${field}.`,
    }];
  }

  const triggerFields = new Set((context.triggerFieldNames ?? []).map((name) => name.toLowerCase()));
  const normalized = field.toLowerCase();

  if (triggerFields.has(normalized)) {
    return [{
      type: "trigger",
      path: field,
      description: `Use ${field} from the trigger payload.`,
    }];
  }

  const prior = priorActionProvidesField(field, context.priorActions);
  if (prior) {
    return [{
      type: "previous_action",
      path: field,
      actionSlug: prior.actionSlug,
      description: `Use ${field} from ${prior.actionSlug} output.`,
    }];
  }

  if (isPlannableField(field)) {
    return [{
      type: "planner",
      description: `Construct ${field} from the loop goal, current run context, and prior action outputs.`,
    }];
  }

  if (fieldLooksLikeIdentifier(field)) {
    if (!context.triggerFieldNames || context.triggerFieldNames.length === 0) {
      return [
        {
          type: "trigger",
          path: field,
          description: `Use exact ${field} from trigger payload when present.`,
        },
        {
          type: "previous_action",
          path: field,
          description: `Use exact ${field} from a previous action output.`,
        },
      ];
    }
    if (triggerFields.has(normalized)) {
      return [{
        type: "trigger",
        path: field,
        description: `Use ${field} from the trigger payload.`,
      }];
    }
    const prior = priorActionProvidesField(field, context.priorActions);
    if (prior) {
      return [{
        type: "previous_action",
        path: field,
        actionSlug: prior.actionSlug,
        description: `Use ${field} from ${prior.actionSlug} output.`,
      }];
    }
    return [];
  }

  return [{
    type: "planner",
    description: `Construct ${field} from the loop goal, current run context, and prior action outputs.`,
  }];
}

export function evaluateActionFeasibility(input: {
  actionSlug: string;
  inputSchema: Record<string, unknown>;
  context?: FeasibilityContext;
}): ActionFeasibilityResult {
  const context = input.context ?? {};
  const summary = summarizeInputSchema(input.inputSchema);
  const required = summary.required.filter((field) => !isOperationalField(field));
  const requiredFields: RequiredFieldSummary[] = [];
  const unresolvableFields: string[] = [];
  const inputInstructions: ComposioActionInstruction["inputInstructions"] = [];

  for (const field of [...new Set([...required, ...summary.properties])]) {
    const sources = resolveFieldSources(field, input.inputSchema, context);
    const isRequired = required.includes(field);
    inputInstructions.push({
      field,
      required: isRequired,
      description: fieldDescriptionFromSchema(input.inputSchema, field),
      sources: isRequired ? sources : [],
    });
    if (!isRequired) continue;
    requiredFields.push({
      field,
      type: fieldTypeFromSchema(input.inputSchema, field),
      description: fieldDescriptionFromSchema(input.inputSchema, field),
      source: summarizeSource(sources),
    });
    if (sources.length === 0) unresolvableFields.push(field);
  }

  const feasible = unresolvableFields.length === 0;
  const feasibilityReason = feasible
    ? undefined
    : `${input.actionSlug} requires ${unresolvableFields.join(", ")} but ${
      context.triggerSlug
        ? `trigger ${context.triggerSlug} does not emit ${unresolvableFields.join(", ")}`
        : "no trigger is configured yet"
    }`;

  return {
    feasible,
    requiredFields,
    unresolvableFields,
    feasibilityReason,
    inputInstructions,
  };
}

function sourceForRequiredField(
  field: string,
  existing?: ComposioActionInstruction,
  context?: FeasibilityContext,
): ComposioActionInputSource[] {
  const fromExisting = existing?.inputInstructions.find((row) => row.field === field)?.sources;
  if (fromExisting?.length) return fromExisting;
  return resolveFieldSources(field, {}, context ?? {});
}

function schemaWithHiddenOperationalFields(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const row = asRecord(inputSchema) ?? {};
  const properties = asRecord(row.properties) ?? {};
  if (Object.keys(properties).length === 0) return inputSchema;

  const required = Array.isArray(row.required)
    ? row.required.filter((field): field is string => typeof field === "string")
    : [];
  const nextProperties: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(properties)) {
    if (isOperationalField(field)) continue;
    nextProperties[field] = schema;
  }

  return {
    ...row,
    properties: nextProperties,
    required: required.filter((field) => !isOperationalField(field)),
  };
}

function buildBehaviorInstructions(input: {
  actionSlug: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  hiddenFields: string[];
}): string[] {
  const required = summarizeInputSchema(input.inputSchema).required;
  const outputs = outputFieldNames(input.outputSchema);
  return [
    `Exact Composio action: ${input.actionSlug}.`,
    input.description?.trim()
      ? `Action description: ${input.description.trim()}`
      : "Use this action only for the operation described by its schema.",
    required.length
      ? `Required inputs are resolved by the runner from allowed sources: ${required.join(", ")}.`
      : "This action has no required inputs in the fetched Composio schema.",
    input.hiddenFields.length
      ? `Runner controls hidden/defaulted fields: ${input.hiddenFields.join(", ")}.`
      : "No operational fields were hidden from the planner.",
    outputs.length
      ? `After success, treat these output fields as available for later actions when present: ${outputs.join(", ")}.`
      : "Use the returned action result as the source for later configured output mappings.",
    "Do not call this action again only to obtain fields already present in run history.",
  ];
}

function buildInstructionFromModifiedSchema(input: {
  toolkit: string;
  actionSlug: string;
  label?: string;
  originalInputSchema: Record<string, unknown>;
  originalOutputSchema?: Record<string, unknown>;
  existing?: ComposioActionInstruction;
  context?: FeasibilityContext;
}): ComposioActionInstruction {
  const base = buildComposioActionInstruction({
    toolkit: input.toolkit,
    actionSlug: input.actionSlug,
    label: input.label,
    inputSchema: input.originalInputSchema,
    outputSchema: input.originalOutputSchema,
  });
  const required = summarizeInputSchema(input.originalInputSchema).required;
  return {
    ...base,
    inputInstructions: base.inputInstructions.map((row) => ({
      ...row,
      sources: required.includes(row.field)
        ? sourceForRequiredField(row.field, input.existing, input.context)
        : [],
    })),
    outputInstructions: input.existing?.outputInstructions?.length
      ? input.existing.outputInstructions
      : base.outputInstructions,
    dependsOn: input.existing?.dependsOn ?? base.dependsOn,
  };
}

export function buildComposioToolContract(input: {
  toolkit: string;
  actionSlug: string;
  label?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  existingInstruction?: ComposioActionInstruction;
  bindingRole?: "trigger" | "source" | "transform" | "destination";
  feasibilityContext?: FeasibilityContext;
}): {
  contract: ComposioToolContract;
  composioAction: ComposioActionInstruction;
  feasibility: ActionFeasibilityResult;
} {
  const summary = summarizeInputSchema(input.inputSchema);
  const fields = [...new Set([...summary.required, ...summary.properties])];
  const hiddenFields = fields.filter(isOperationalField);
  const modifiedInputSchema = schemaWithHiddenOperationalFields(input.inputSchema);
  const feasibility = evaluateActionFeasibility({
    actionSlug: input.actionSlug,
    inputSchema: input.inputSchema,
    context: input.feasibilityContext,
  });
  const composioAction = buildInstructionFromModifiedSchema({
    toolkit: input.toolkit,
    actionSlug: input.actionSlug,
    label: input.label,
    originalInputSchema: input.inputSchema,
    originalOutputSchema: input.outputSchema,
    existing: input.existingInstruction,
    context: input.feasibilityContext,
  });
  const outputSufficiencyPaths = composioAction.outputInstructions
    .map((instruction) => instruction.path ?? instruction.name);
  return {
    contract: {
      originalInputSchema: input.inputSchema,
      ...(input.outputSchema ? { originalOutputSchema: input.outputSchema } : {}),
      modifiedInputSchema,
      behaviorInstructions: buildBehaviorInstructions({
        actionSlug: input.actionSlug,
        description: input.description,
        inputSchema: input.inputSchema,
        outputSchema: input.outputSchema,
        hiddenFields,
      }),
      outputSufficiencyPaths,
    },
    composioAction,
    feasibility,
  };
}

export function enrichBindingActionCandidate(input: {
  actionSlug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  context?: FeasibilityContext;
}): {
  actionSlug: string;
  name: string;
  description: string;
  requiredFields: RequiredFieldSummary[];
  feasible: boolean;
  unresolvableFields: string[];
  feasibilityReason?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
} {
  const feasibility = evaluateActionFeasibility({
    actionSlug: input.actionSlug,
    inputSchema: input.inputSchema,
    context: input.context,
  });
  return {
    actionSlug: input.actionSlug,
    name: input.name,
    description: input.description,
    requiredFields: feasibility.requiredFields,
    feasible: feasibility.feasible,
    unresolvableFields: feasibility.unresolvableFields,
    feasibilityReason: feasibility.feasibilityReason,
    inputSchema: input.inputSchema,
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
}

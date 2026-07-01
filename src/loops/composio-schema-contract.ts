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

function fieldMatches(field: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(field));
}

function isOperationalField(field: string): boolean {
  return fieldMatches(field, HIDDEN_FIELD_PATTERNS) || fieldMatches(field, LIMIT_FIELD_PATTERNS);
}

function defaultForField(field: string): unknown {
  if (field in HIDDEN_DEFAULTS) return HIDDEN_DEFAULTS[field];
  if (fieldMatches(field, LIMIT_FIELD_PATTERNS)) return 1;
  return undefined;
}

function sourceForRequiredField(field: string, existing?: ComposioActionInstruction): ComposioActionInputSource[] {
  const fromExisting = existing?.inputInstructions.find((row) => row.field === field)?.sources;
  if (fromExisting?.length) return fromExisting;

  const defaultValue = defaultForField(field);
  if (defaultValue !== undefined) {
    return [{
      type: "static",
      value: defaultValue,
      description: `Runner-controlled default for operational field ${field}.`,
    }];
  }

  const normalized = field.toLowerCase();
  if (normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("id")) {
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

  return [{
    type: "planner",
    description: `Construct ${field} from the loop goal, current run context, and prior action outputs.`,
  }];
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

function outputFieldNames(outputSchema?: Record<string, unknown>): string[] {
  const row = asRecord(outputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  return Object.keys(properties).filter((field) => field !== "type" && field !== "required").slice(0, 12);
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
        ? sourceForRequiredField(row.field, input.existing)
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
}): {
  contract: ComposioToolContract;
  composioAction: ComposioActionInstruction;
} {
  const summary = summarizeInputSchema(input.inputSchema);
  const fields = [...new Set([...summary.required, ...summary.properties])];
  const hiddenFields = fields.filter(isOperationalField);
  const modifiedInputSchema = schemaWithHiddenOperationalFields(input.inputSchema);
  const composioAction = buildInstructionFromModifiedSchema({
    toolkit: input.toolkit,
    actionSlug: input.actionSlug,
    label: input.label,
    originalInputSchema: input.inputSchema,
    originalOutputSchema: input.outputSchema,
    existing: input.existingInstruction,
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
  };
}

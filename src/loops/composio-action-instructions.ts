import type {
  ComposioActionInstruction,
  ComposioActionInputInstruction,
  ComposioActionInputSource,
  CompiledPlan,
  ResolvedTool,
} from "./spec.js";
import { summarizeInputSchema } from "./tool-schema.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function actionKey(toolkit: string, actionSlug: string): string {
  return `${toolkit.toLowerCase()}:${actionSlug.toUpperCase()}`;
}

function fieldLooksLikeIdentifier(field: string): boolean {
  const normalized = field.toLowerCase();
  return normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("id");
}

function fieldLooksLikeQuery(field: string): boolean {
  return /query|search|filter|q$/i.test(field);
}

function sourceForRequiredField(field: string): ComposioActionInputSource[] {
  if (fieldLooksLikeIdentifier(field)) {
    return [
      {
        type: "trigger",
        path: field,
        description: `Use ${field} from the run trigger payload when present.`,
      },
      {
        type: "previous_action",
        path: field,
        description: `Use ${field} extracted from an earlier Composio action result.`,
      },
    ];
  }

  if (fieldLooksLikeQuery(field)) {
    return [{
      type: "planner",
      description: `Build ${field} from the loop goal and current run context.`,
    }];
  }

  return [{
    type: "planner",
    description: `Construct ${field} from the loop goal, run context, or configured user intent.`,
  }];
}

function inferInputInstructions(inputSchema: Record<string, unknown>): ComposioActionInputInstruction[] {
  const summary = summarizeInputSchema(inputSchema);
  const fields = [...new Set([...summary.required, ...summary.properties])];
  return fields.map((field) => {
    const required = summary.required.includes(field);
    return {
      field,
      required,
      description: required
        ? `Required Composio input field ${field}.`
        : `Optional Composio input field ${field}.`,
      sources: required ? sourceForRequiredField(field) : [],
    };
  });
}

function inferOutputInstructions(outputSchema?: Record<string, unknown>): ComposioActionInstruction["outputInstructions"] {
  const row = asRecord(outputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  const fields = Object.keys(properties).filter((key) => key !== "required" && key !== "type");
  return fields.slice(0, 16).map((field) => ({
    name: field,
    path: field,
    description: `Extract ${field} from this Composio action result when later actions need it.`,
  }));
}

export function buildComposioActionInstruction(input: {
  toolkit: string;
  actionSlug: string;
  label?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}): ComposioActionInstruction {
  return {
    toolkit: input.toolkit,
    actionSlug: input.actionSlug,
    label: input.label ?? input.actionSlug,
    inputInstructions: inferInputInstructions(input.inputSchema),
    outputInstructions: inferOutputInstructions(input.outputSchema),
    dependsOn: [],
  };
}

export function mergeComposioActionInstructions(input: {
  existing: ComposioActionInstruction[];
  tools: Array<Pick<ResolvedTool, "connector" | "actionSlug" | "inputSchema" | "outputSchema"> & { capability?: string }>;
}): ComposioActionInstruction[] {
  const byAction = new Map<string, ComposioActionInstruction>();
  for (const instruction of input.existing) {
    byAction.set(actionKey(instruction.toolkit, instruction.actionSlug), instruction);
  }

  for (const tool of input.tools) {
    const key = actionKey(tool.connector, tool.actionSlug);
    if (byAction.has(key)) continue;
    byAction.set(key, buildComposioActionInstruction({
      toolkit: tool.connector,
      actionSlug: tool.actionSlug,
      label: tool.capability ?? tool.actionSlug,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
  }

  return [...byAction.values()];
}

export function attachComposioActionInstructionsToTools<T extends Pick<ResolvedTool, "connector" | "actionSlug">>(
  tools: T[],
  instructions: ComposioActionInstruction[],
): Array<T & { composioAction?: ComposioActionInstruction }> {
  const byAction = new Map(instructions.map((instruction) => [
    actionKey(instruction.toolkit, instruction.actionSlug),
    instruction,
  ]));
  return tools.map((tool) => {
    const instruction = byAction.get(actionKey(tool.connector, tool.actionSlug));
    return instruction ? { ...tool, composioAction: instruction } : tool;
  });
}

export function validateComposioActionInstructions(input: {
  tools: Array<Pick<ResolvedTool, "connector" | "actionSlug" | "inputSchema">>;
  instructions: ComposioActionInstruction[];
}): Array<{ code: string; message: string; binding?: string; toolkit?: string }> {
  const errors: Array<{ code: string; message: string; binding?: string; toolkit?: string }> = [];
  const byAction = new Map(input.instructions.map((instruction) => [
    actionKey(instruction.toolkit, instruction.actionSlug),
    instruction,
  ]));

  for (const tool of input.tools) {
    const instruction = byAction.get(actionKey(tool.connector, tool.actionSlug));
    if (!instruction) {
      errors.push({
        code: "MISSING_COMPOSIO_ACTION_INSTRUCTIONS",
        message: `${tool.actionSlug} is missing composioActions instructions`,
        binding: tool.actionSlug,
        toolkit: tool.connector,
      });
      continue;
    }

    const required = summarizeInputSchema(tool.inputSchema).required;
    for (const field of required) {
      const fieldInstruction = instruction.inputInstructions.find((row) => row.field === field);
      if (!fieldInstruction || fieldInstruction.sources.length === 0) {
        errors.push({
          code: "MISSING_INPUT_SOURCE",
          message: `${tool.actionSlug} requires ${field}, but composioActions has no input source for it`,
          binding: `${tool.actionSlug}.${field}`,
          toolkit: tool.connector,
        });
        continue;
      }

      for (const source of fieldInstruction.sources) {
        if (source.type === "trigger" && !source.path) {
          errors.push({
            code: "INVALID_INPUT_SOURCE",
            message: `${tool.actionSlug}.${field} trigger source must specify path`,
            binding: `${tool.actionSlug}.${field}`,
            toolkit: tool.connector,
          });
        }
        if (source.type === "static" && source.value === undefined) {
          errors.push({
            code: "INVALID_INPUT_SOURCE",
            message: `${tool.actionSlug}.${field} static source must specify value`,
            binding: `${tool.actionSlug}.${field}`,
            toolkit: tool.connector,
          });
        }
        if (source.type === "previous_action" && !source.path) {
          errors.push({
            code: "INVALID_INPUT_SOURCE",
            message: `${tool.actionSlug}.${field} previous_action source must specify output path`,
            binding: `${tool.actionSlug}.${field}`,
            toolkit: tool.connector,
          });
        }
        if (source.type === "user_config" && !source.path) {
          errors.push({
            code: "INVALID_INPUT_SOURCE",
            message: `${tool.actionSlug}.${field} user_config source must specify path`,
            binding: `${tool.actionSlug}.${field}`,
            toolkit: tool.connector,
          });
        }
        if (source.type === "planner" && !source.description) {
          errors.push({
            code: "INVALID_INPUT_SOURCE",
            message: `${tool.actionSlug}.${field} planner source must describe how to construct the value`,
            binding: `${tool.actionSlug}.${field}`,
            toolkit: tool.connector,
          });
        }
      }
    }
  }

  return errors;
}

function valueAtPath(value: unknown, path?: string): unknown {
  if (!path) return undefined;
  const segments = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : current[0];
      continue;
    }
    const row = asRecord(current);
    if (!row) return undefined;
    current = row[segment];
  }
  return current;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function valueFromToolHistory(input: {
  plan: CompiledPlan;
  actionSlug?: string;
  path?: string;
  toolResults: Array<{ toolId: string; result: unknown }>;
}): unknown {
  for (let i = input.toolResults.length - 1; i >= 0; i -= 1) {
    const result = input.toolResults[i]!;
    const tool = input.plan.toolCatalog.find((row) => row.id === result.toolId);
    if (input.actionSlug && tool?.actionSlug.toUpperCase() !== input.actionSlug.toUpperCase()) continue;
    const data = asRecord(result.result)?.data ?? result.result;
    const direct = valueAtPath(data, input.path);
    if (direct !== undefined && direct !== null && direct !== "") return direct;
    const messages = asRecord(data)?.messages;
    if (Array.isArray(messages)) {
      const fromFirstMessage = valueAtPath(messages[0], input.path);
      if (fromFirstMessage !== undefined && fromFirstMessage !== null && fromFirstMessage !== "") {
        return fromFirstMessage;
      }
    }
  }
  return undefined;
}

export function resolveComposioActionArgs(input: {
  plan: CompiledPlan;
  tool: ResolvedTool;
  args: Record<string, unknown>;
  eventPayload?: unknown;
  toolResults: Array<{ toolId: string; result: unknown }>;
  userConfig?: unknown;
}): {
  args: Record<string, unknown>;
  missing: Array<{
    field: string;
    actionSlug: string;
    toolId: string;
    expectedSources: ComposioActionInputSource[];
  }>;
} {
  const instruction = input.tool.composioAction
    ?? input.plan.composioActions.find((row) => actionKey(row.toolkit, row.actionSlug) === actionKey(input.tool.connector, input.tool.actionSlug));
  const args: Record<string, unknown> = {};
  const required = summarizeInputSchema(input.tool.originalInputSchema ?? input.tool.inputSchema).required;
  const plannerVisible = new Set(
    summarizeInputSchema(input.tool.modifiedInputSchema ?? input.tool.inputSchema).properties,
  );
  for (const [key, value] of Object.entries(input.args)) {
    if (!required.includes(key) && plannerVisible.has(key)) {
      args[key] = value;
    }
  }
  const inputProperties = new Set(
    summarizeInputSchema(input.tool.originalInputSchema ?? input.tool.inputSchema).properties,
  );
  for (const field of inputProperties) {
    if (required.includes(field) || field in args) continue;
    const triggerValue = firstDefined(
      valueAtPath(input.eventPayload, field),
      valueAtPath(asRecord(input.eventPayload)?.payload, field),
    );
    if (triggerValue !== undefined) args[field] = triggerValue;
  }
  const missing: Array<{
    field: string;
    actionSlug: string;
    toolId: string;
    expectedSources: ComposioActionInputSource[];
  }> = [];

  for (const field of required) {
    const fieldInstruction = instruction?.inputInstructions.find((row) => row.field === field);
    let resolved: unknown;

    for (const source of fieldInstruction?.sources ?? []) {
      if (source.type === "trigger") {
        resolved = firstDefined(valueAtPath(input.eventPayload, source.path), valueAtPath(asRecord(input.eventPayload)?.payload, source.path));
      } else if (source.type === "static") {
        resolved = source.value;
      } else if (source.type === "previous_action") {
        resolved = valueFromToolHistory({
          plan: input.plan,
          actionSlug: source.actionSlug,
          path: source.path,
          toolResults: input.toolResults,
        });
      } else if (source.type === "user_config") {
        resolved = valueAtPath(input.userConfig, source.path);
      } else if (source.type === "planner") {
        resolved = input.args[field];
      }
      if (resolved !== undefined && resolved !== null && resolved !== "") break;
    }

    if (resolved !== undefined && resolved !== null && resolved !== "") {
      args[field] = resolved;
    } else {
      missing.push({
        field,
        actionSlug: input.tool.actionSlug,
        toolId: input.tool.id,
        expectedSources: fieldInstruction?.sources ?? [],
      });
    }
  }

  return { args, missing };
}

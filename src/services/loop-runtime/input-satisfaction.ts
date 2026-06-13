import type { z } from "zod";
import { detectPlaceholderText } from "../loop-engine/contracts.js";
import {
  inputRequirementSchema,
  isInputSurface,
  type InputRequirement,
  type InputRequirementWhen,
  type InputSurface,
  type SurfaceSubmissionValue,
} from "../loop-engine/input-surfaces.js";
import { parseContactListCsv } from "../loop-executor/csv-parser.js";
import type { LoopContactRow, LoopDefinition } from "../loop-executor/types.js";
import { buildDeliveryRecipientsPatch } from "./contacts-context.js";
import { runtimeContextSchema } from "./types.js";

type RuntimeContextShape = z.infer<typeof runtimeContextSchema>;

export type RequirementEvaluation = {
  requirement: InputRequirement;
  satisfied: boolean;
  message?: string;
};

export type ValidationResult = { ok: true } | { ok: false; message: string };

export function collectRequirements(definition: LoopDefinition): InputRequirement[] {
  return definition.inputRequirements ?? [];
}

export function readRequirementValue(
  requirement: InputRequirement,
  context: RuntimeContextShape,
): unknown {
  switch (requirement.surface) {
    case "input.contacts_csv": {
      const contacts = context.deliveryRecipients?.contacts ?? [];
      if (contacts.length > 0) return { contacts };
      return context.inputs[requirement.key];
    }
    case "input.audience_id": {
      const audienceId = context.deliveryRecipients?.audienceId?.trim()
        ?? context.inputs[requirement.key]?.trim();
      return audienceId ? { audienceId } : undefined;
    }
    case "input.file":
      return context.inputs[requirement.key] ?? context.deliveryRecipients?.documentRef;
    case "input.text":
    case "input.markdown":
      return context.inputs[requirement.key];
    case "review.draft":
    case "review.email":
    case "review.preview":
    case "confirm.send":
      return undefined;
    default:
      return context.inputs[requirement.key];
  }
}

export function resolvedRuntimeInputs(
  definition: LoopDefinition,
  context: RuntimeContextShape,
): Record<string, unknown> {
  return Object.fromEntries(collectRequirements(definition).flatMap((requirement) => {
    const value = readRequirementValue(requirement, context);
    return value === undefined ? [] : [[requirement.key, value]];
  }));
}

export function validateSurfaceValue(
  surface: InputSurface,
  value: unknown,
  requirement?: Pick<InputRequirement, "key" | "required">,
): ValidationResult {
  if (surface === "input.text" || surface === "input.markdown") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { ok: false, message: `${requirement?.key ?? "Input"} is required.` };
    if (detectPlaceholderText(text)) {
      return { ok: false, message: `${requirement?.key ?? "Input"} still contains placeholder text.` };
    }
    if (surface === "input.markdown" && text.length < 20) {
      return { ok: false, message: `${requirement?.key ?? "Input"} is too short.` };
    }
    return { ok: true };
  }
  if (surface === "input.contacts_csv") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const contacts = (value as { contacts?: LoopContactRow[] }).contacts;
      if (Array.isArray(contacts) && contacts.length > 0) return { ok: true };
      const csvText = (value as { csvText?: string }).csvText;
      if (typeof csvText === "string" && csvText.trim()) {
        try {
          parseContactListCsv(csvText);
          return { ok: true };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : "Invalid contact list." };
        }
      }
    }
    if (typeof value === "string" && value.trim()) {
      try {
        parseContactListCsv(value);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Invalid contact list." };
      }
    }
    return { ok: false, message: "Upload or paste at least one recipient." };
  }
  if (surface === "input.audience_id") {
    const audienceId = typeof value === "string"
      ? value.trim()
      : value && typeof value === "object" && !Array.isArray(value)
        ? String((value as { audienceId?: string }).audienceId ?? "").trim()
        : "";
    if (!audienceId) return { ok: false, message: "Audience or list ID is required." };
    return { ok: true };
  }
  if (surface === "input.file") {
    const ref = typeof value === "string" ? value.trim() : "";
    if (!ref) return { ok: false, message: "File reference is required." };
    return { ok: true };
  }
  return { ok: true };
}

export function isRequirementSatisfied(
  requirement: InputRequirement,
  context: RuntimeContextShape,
  _definition: LoopDefinition,
): RequirementEvaluation {
  const value = readRequirementValue(requirement, context);
  if (value === undefined || value === null || value === "") {
    return { requirement, satisfied: !requirement.required, message: `${requirement.key} is missing.` };
  }
  const validation = validateSurfaceValue(requirement.surface, value, requirement);
  return {
    requirement,
    satisfied: validation.ok,
    message: validation.ok ? undefined : validation.message,
  };
}

export function evaluateAt(
  definition: LoopDefinition,
  context: RuntimeContextShape,
  when: InputRequirementWhen,
): RequirementEvaluation[] {
  return collectRequirements(definition)
    .filter((req) => req.when === when)
    .map((req) => isRequirementSatisfied(req, context, definition))
    .filter((result) => result.requirement.required && !result.satisfied);
}

/** Operator paste/upload requirements that block agent execution — not send approval surfaces. */
export function evaluateExecutionBlockingAt(
  definition: LoopDefinition,
  context: RuntimeContextShape,
  when: InputRequirementWhen,
): RequirementEvaluation[] {
  return evaluateAt(definition, context, when)
    .filter((row) => isInputSurface(row.requirement.surface));
}

export function unsatisfiedRequirementKeys(
  definition: LoopDefinition,
  context: RuntimeContextShape,
  when: InputRequirementWhen,
): string[] {
  return evaluateAt(definition, context, when).map((result) => result.requirement.key);
}

export function applySurfaceSubmission(input: {
  key: string;
  requirement: InputRequirement;
  value: SurfaceSubmissionValue;
}): Partial<RuntimeContextShape> {
  const { key, requirement, value } = input;
  if (value.surface !== requirement.surface) {
    throw new Error(`Surface mismatch for ${key}: expected ${requirement.surface}, got ${value.surface}`);
  }
  const validation = validateSurfaceValue(requirement.surface, submissionToRawValue(value), requirement);
  if (!validation.ok) throw new Error(validation.message);

  if (requirement.surface === "input.contacts_csv") {
    const contacts = value.contacts?.length
      ? value.contacts
      : value.csvText
        ? parseContactListCsv(value.csvText)
        : [];
    return {
      deliveryRecipients: buildDeliveryRecipientsPatch({
        contacts,
        source: "uploaded",
        audienceId: value.audienceId,
      }),
      inputs: { [key]: `${contacts.length} contacts` },
    };
  }
  if (requirement.surface === "input.audience_id") {
    const audienceId = value.audienceId?.trim() ?? "";
    return {
      deliveryRecipients: buildDeliveryRecipientsPatch({
        contacts: [],
        source: "configured",
        audienceId,
      }),
      inputs: { [key]: audienceId },
    };
  }
  if (requirement.surface === "input.file") {
    const fileRef = value.fileRef?.trim() ?? "";
    return { inputs: { [key]: fileRef } };
  }
  const text = value.text?.trim() ?? "";
  return { inputs: { [key]: text } };
}

export function applyGateSurfaceSubmission(input: {
  definition: LoopDefinition;
  context: RuntimeContextShape;
  values: Record<string, SurfaceSubmissionValue>;
}): RuntimeContextShape {
  const requirements = collectRequirements(input.definition);
  const byKey = new Map(requirements.map((req) => [req.key, req]));
  let nextInputs = { ...input.context.inputs };
  let nextRecipients = input.context.deliveryRecipients;

  for (const [key, value] of Object.entries(input.values)) {
    const requirement = byKey.get(key);
    if (!requirement) throw new Error(`Undeclared operator input: ${key}`);
    if (isBlankSubmissionValue(value) && isRequirementSatisfied(requirement, input.context, input.definition).satisfied) {
      continue;
    }
    const patch = applySurfaceSubmission({ key, requirement, value });
    nextInputs = { ...nextInputs, ...(patch.inputs ?? {}) };
    if (patch.deliveryRecipients) nextRecipients = patch.deliveryRecipients;
  }

  return {
    ...input.context,
    inputs: nextInputs,
    ...(nextRecipients ? { deliveryRecipients: nextRecipients } : {}),
  };
}

function isBlankSubmissionValue(value: SurfaceSubmissionValue): boolean {
  return !value.text?.trim()
    && !value.csvText?.trim()
    && !value.audienceId?.trim()
    && !value.fileRef?.trim()
    && !(value.contacts?.length);
}

function submissionToRawValue(value: SurfaceSubmissionValue): unknown {
  if (value.contacts?.length) return { contacts: value.contacts, csvText: value.csvText };
  if (value.csvText) return value.csvText;
  if (value.audienceId) return { audienceId: value.audienceId };
  if (value.fileRef) return value.fileRef;
  return value.text ?? "";
}

export type RuntimeContext = RuntimeContextShape;

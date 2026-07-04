import { z } from "zod";

import { bindingArtifactSchema } from "./build-state.js";
import { validateConfigAgainstSchema, type ConfigurableField } from "./binding-discovery.js";
import type { ToolBinding } from "./spec.js";
import { capabilityForAction } from "./tool-schema.js";

export type BindingResolverAnswer = {
  questionId: string;
  question: string;
  answerText: string;
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
};

export type BindingResolverActionCandidate = {
  actionSlug: string;
  name: string;
  description: string;
};

export type BindingResolverAction = {
  outcomeId: string;
  connector: string;
  role: "source" | "destination";
  description: string;
  candidates: BindingResolverActionCandidate[];
};

export type BindingResolverTriggerCandidate = {
  slug: string;
  name: string;
  configSchema: Record<string, unknown>;
  configurableFields: ConfigurableField[];
};

export type BindingResolverTrigger = {
  outcomeId: string;
  connector: string;
  description: string;
  candidates: BindingResolverTriggerCandidate[];
};

export type BindingResolutionQuestion = {
  questionId: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    value: string;
    description?: string;
  }>;
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  outcomeId: string;
  role: "trigger" | "source" | "destination";
};

export type BindingResolutionInput = {
  actions: BindingResolverAction[];
  trigger: BindingResolverTrigger | null;
  answers: BindingResolverAnswer[];
  userId?: string;
};

type SelectedBindingResolution = {
  actions: Array<BindingResolverAction & { selected: BindingResolverActionCandidate }>;
  trigger: (BindingResolverTrigger & {
    selected: BindingResolverTriggerCandidate;
    configAnswer?: BindingResolverAnswer;
  }) | null;
};

export type PreparedBindingResolution =
  | { ready: false; pendingQuestions: BindingResolutionQuestion[] }
  | { ready: true; selected: SelectedBindingResolution; schema: z.ZodTypeAny; prompt: string };

const BINDING_ACTION_QUESTION = /^binding-action-([^-][\w-]*)$/;
const BINDING_TRIGGER_QUESTION = /^binding-trigger-([^-][\w-]*)$/;
const BINDING_CONFIG_QUESTION = /^binding-config-([^-][\w-]*)-([\w-]+)$/;

export function isBindingResolutionQuestionId(questionId: string): boolean {
  return BINDING_ACTION_QUESTION.test(questionId)
    || BINDING_TRIGGER_QUESTION.test(questionId)
    || BINDING_CONFIG_QUESTION.test(questionId);
}

export function filterBindingResolutionAnswers(answers: BindingResolverAnswer[]): BindingResolverAnswer[] {
  return answers.filter((answer) => isBindingResolutionQuestionId(answer.questionId));
}

export class InvalidBindingScopeAnswerError extends Error {
  readonly fieldKey: string;
  readonly rejectedValues: string[];

  constructor(fieldKey: string, rejectedValues: string[]) {
    super(`Trigger scope answer uses values that are not in the provider catalogue: ${rejectedValues.join(", ") || "(empty)"}`);
    this.name = "InvalidBindingScopeAnswerError";
    this.fieldKey = fieldKey;
    this.rejectedValues = rejectedValues;
  }
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function actionAnswerFor(
  answers: BindingResolverAnswer[],
  outcomeId: string,
  candidates: BindingResolverActionCandidate[],
): BindingResolverAnswer | undefined {
  const expectedQuestionId = `binding-action-${outcomeId}`;
  const allowed = new Set(candidates.map((candidate) => candidate.actionSlug.toLowerCase()));
  return answers.slice().reverse().find((answer) =>
    answer.questionId === expectedQuestionId
    && [...answer.selectedValues, ...answer.selectedOptionIds]
      .some((value) => allowed.has(value.toLowerCase())));
}

function triggerAnswerFor(
  answers: BindingResolverAnswer[],
  outcomeId: string,
  candidates: BindingResolverTriggerCandidate[],
): BindingResolverAnswer | undefined {
  const expectedQuestionId = `binding-trigger-${outcomeId}`;
  const allowed = new Set(candidates.map((candidate) => candidate.slug.toLowerCase()));
  return answers.slice().reverse().find((answer) =>
    answer.questionId === expectedQuestionId
    && [...answer.selectedValues, ...answer.selectedOptionIds]
      .some((value) => allowed.has(value.toLowerCase())));
}

function configAnswerFor(
  answers: BindingResolverAnswer[],
  outcomeId: string,
  fieldKey: string,
): BindingResolverAnswer | undefined {
  const expectedQuestionId = `binding-config-${outcomeId}-${fieldKey}`;
  return answers.slice().reverse().find((answer) => answer.questionId === expectedQuestionId);
}

function fieldValueSchema(field: ConfigurableField): z.ZodTypeAny {
  const optionValues = uniqueBy(field.options.map((option) => option.value), String);
  const stringOptions = optionValues.filter((value): value is string => typeof value === "string");
  const numberOptions = optionValues.filter((value): value is number => typeof value === "number");
  const booleanOptions = optionValues.filter((value): value is boolean => typeof value === "boolean");

  const stringValue = stringOptions.length > 0
    ? z.enum(stringOptions as [string, ...string[]])
    : z.string();
  if (field.type === "array") return z.array(stringValue).min(1);
  if (field.type === "string") return stringValue;
  if (field.type === "number") {
    if (numberOptions.length === 1) return z.literal(numberOptions[0]!);
    if (numberOptions.length > 1) {
      return z.union(numberOptions.map((value) => z.literal(value)) as [
        z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[],
      ]);
    }
    return z.number();
  }
  if (booleanOptions.length === 1) return z.literal(booleanOptions[0]!);
  return z.boolean();
}

function configSchemaFor(fields: ConfigurableField[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return z.object(Object.fromEntries(fields.map((field) => [field.key, fieldValueSchema(field)]))).strict();
}

function actionQuestion(action: BindingResolverAction): BindingResolutionQuestion {
  return {
    questionId: `binding-action-${action.outcomeId}`,
    question: `Which method should ${action.connector} use for ${action.description}?`,
    options: action.candidates.map((candidate) => ({
      id: candidate.actionSlug,
      label: candidate.name,
      value: candidate.actionSlug,
      description: candidate.description,
    })),
    outcomeId: action.outcomeId,
    role: action.role,
  };
}

function triggerQuestion(trigger: BindingResolverTrigger): BindingResolutionQuestion {
  return {
    questionId: `binding-trigger-${trigger.outcomeId}`,
    question: `Which ${trigger.connector} event should start ${trigger.description}?`,
    options: trigger.candidates.map((candidate) => ({
      id: candidate.slug,
      label: candidate.name,
      value: candidate.slug,
      description: candidate.slug,
    })),
    outcomeId: trigger.outcomeId,
    role: "trigger",
  };
}

function configQuestion(
  trigger: BindingResolverTrigger,
  selected: BindingResolverTriggerCandidate,
): BindingResolutionQuestion {
  const field = selected.configurableFields[0]!;
  const options = field.options.length >= 1
    ? field.options.slice(0, 25).map((option) => ({
      id: String(option.value),
      label: option.label,
      value: String(option.value),
      description: field.description || undefined,
    }))
    : [
      { id: "all", label: "All matching items", value: "all", description: field.description || undefined },
      { id: "specific", label: "A specific scope", value: "specific", description: field.description || undefined },
    ];
  return {
    questionId: `binding-config-${trigger.outcomeId}-${field.key}`,
    question: `What ${field.label.toLowerCase()} should ${trigger.description} use?`,
    options,
    recommendedOptionIds: options.length > 0 ? [options[0]!.id] : undefined,
    allowMultiple: field.type === "array",
    allowOther: field.options.length < 2,
    outcomeId: trigger.outcomeId,
    role: "trigger",
  };
}

export function prepareBindingResolution(input: BindingResolutionInput): PreparedBindingResolution {
  const answers = filterBindingResolutionAnswers(input.answers);
  const pendingQuestions: BindingResolutionQuestion[] = [];
  const selectedActions: SelectedBindingResolution["actions"] = [];

  for (const action of input.actions) {
    const candidates = uniqueBy(action.candidates, (candidate) => candidate.actionSlug);
    if (candidates.length === 0) continue;
    const answer = candidates.length > 1
      ? actionAnswerFor(answers, action.outcomeId, candidates)
      : undefined;
    const selected = candidates.length === 1
      ? candidates[0]
      : candidates.find((candidate) =>
        [...(answer?.selectedValues ?? []), ...(answer?.selectedOptionIds ?? [])]
          .some((value) => value.toLowerCase() === candidate.actionSlug.toLowerCase()));
    if (!selected) {
      pendingQuestions.push(actionQuestion({ ...action, candidates }));
      continue;
    }
    selectedActions.push({ ...action, candidates, selected });
  }

  let selectedTrigger: SelectedBindingResolution["trigger"] = null;
  if (input.trigger) {
    const candidates = uniqueBy(input.trigger.candidates, (candidate) => candidate.slug);
    const answer = candidates.length > 1
      ? triggerAnswerFor(answers, input.trigger.outcomeId, candidates)
      : undefined;
    const selected = candidates.length === 1
      ? candidates[0]
      : candidates.find((candidate) =>
        [...(answer?.selectedValues ?? []), ...(answer?.selectedOptionIds ?? [])]
          .some((value) => value.toLowerCase() === candidate.slug.toLowerCase()));
    if (!selected && candidates.length > 0) {
      pendingQuestions.push(triggerQuestion({ ...input.trigger, candidates }));
    } else if (selected) {
      const configField = selected.configurableFields[0];
      const configAnswer = configField
        ? configAnswerFor(answers, input.trigger.outcomeId, configField.key)
        : undefined;
      if (selected.configurableFields.length > 0 && !configAnswer) {
        pendingQuestions.push(configQuestion(input.trigger, selected));
      }
      selectedTrigger = { ...input.trigger, candidates, selected, ...(configAnswer ? { configAnswer } : {}) };
    }
  }

  if (selectedActions.length !== input.actions.length || (input.trigger && !selectedTrigger)) {
    return { ready: false, pendingQuestions };
  }
  if (selectedTrigger?.selected.configurableFields.length && !selectedTrigger.configAnswer) {
    return { ready: false, pendingQuestions };
  }
  if (pendingQuestions.length > 0) return { ready: false, pendingQuestions };

  const actionShape = Object.fromEntries(selectedActions.map((action) => [
    action.outcomeId,
    z.literal(action.selected.actionSlug),
  ]));
  const triggerSchema = selectedTrigger
    ? z.object({
      outcomeId: z.literal(selectedTrigger.outcomeId),
      connector: z.literal(selectedTrigger.connector),
      triggerSlug: z.literal(selectedTrigger.selected.slug),
      config: configSchemaFor(selectedTrigger.selected.configurableFields),
    }).strict()
    : z.null();
  const schema = z.object({
    actions: z.object(actionShape).strict(),
    trigger: triggerSchema,
  }).strict();

  const prompt = [
    "Resolve the complete workflow binding using only the values permitted by the output schema.",
    "Preserve every exact provider action and trigger identifier. Never add fields.",
    selectedTrigger?.configAnswer
      ? `Trigger scope answer: ${JSON.stringify(selectedTrigger.configAnswer)}`
      : "No trigger scope configuration is required.",
    `Workflow context: ${JSON.stringify({
      actions: selectedActions.map((action) => ({
        outcomeId: action.outcomeId,
        description: action.description,
        connector: action.connector,
        actionSlug: action.selected.actionSlug,
      })),
      trigger: selectedTrigger ? {
        outcomeId: selectedTrigger.outcomeId,
        description: selectedTrigger.description,
        connector: selectedTrigger.connector,
        triggerSlug: selectedTrigger.selected.slug,
        configurableFields: selectedTrigger.selected.configurableFields,
      } : null,
    })}`,
  ].join("\n\n");

  return { ready: true, selected: { actions: selectedActions, trigger: selectedTrigger }, schema, prompt };
}

const CONFIG_PLACEHOLDER_VALUES = new Set(["specific", "all"]);

function resolveConfigValues(answer: BindingResolverAnswer, field: ConfigurableField): string[] {
  let values = uniqueBy(
    [...answer.selectedValues, ...answer.selectedOptionIds].map(String),
    (value) => value.toLowerCase(),
  );
  if (answer.otherText?.trim()) {
    values = values.filter((value) => !CONFIG_PLACEHOLDER_VALUES.has(value.toLowerCase()));
    values.push(answer.otherText.trim());
  } else {
    values = values.filter((value) => !CONFIG_PLACEHOLDER_VALUES.has(value.toLowerCase()));
  }
  if (field.options.length > 0) {
    const allowed = new Set(field.options.map((option) => String(option.value)));
    const matched = values.filter((value) => allowed.has(value));
    if (matched.length > 0) return matched;
    throw new InvalidBindingScopeAnswerError(field.key, values);
  }
  if (values.length === 0) {
    throw new InvalidBindingScopeAnswerError(field.key, values);
  }
  return values;
}

export function mapConfigAnswer(
  fields: ConfigurableField[],
  answer: BindingResolverAnswer | undefined,
): Record<string, unknown> {
  if (!answer || fields.length === 0) return {};
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const values = resolveConfigValues(answer, field);
    if (field.type === "array") {
      config[field.key] = values;
    } else if (field.type === "number") {
      config[field.key] = Number(values[0]);
    } else if (field.type === "boolean") {
      config[field.key] = values[0]?.toLowerCase() === "true";
    } else {
      config[field.key] = values[0] ?? "";
    }
  }
  return config;
}

export type ResolvedBindingPayload = {
  actions: Record<string, string>;
  trigger: {
    outcomeId: string;
    connector: string;
    triggerSlug: string;
    config: Record<string, unknown>;
  } | null;
};

export function buildResolvedPayload(
  prepared: Extract<PreparedBindingResolution, { ready: true }>,
): ResolvedBindingPayload {
  const actions = Object.fromEntries(prepared.selected.actions.map((action) => [
    action.outcomeId,
    action.selected.actionSlug,
  ]));
  const selectedTrigger = prepared.selected.trigger;
  if (!selectedTrigger) return { actions, trigger: null };
  return {
    actions,
    trigger: {
      outcomeId: selectedTrigger.outcomeId,
      connector: selectedTrigger.connector,
      triggerSlug: selectedTrigger.selected.slug,
      config: mapConfigAnswer(
        selectedTrigger.selected.configurableFields,
        selectedTrigger.configAnswer,
      ),
    },
  };
}

export function describeBindingResolutionError(error: unknown): {
  code: "BINDING_RESOLVER_PROVIDER_ERROR" | "BINDING_RESOLUTION_FAILED" | "INVALID_BINDING_SCOPE_ANSWER";
  message: string;
} {
  if (error instanceof InvalidBindingScopeAnswerError) {
    return {
      code: "INVALID_BINDING_SCOPE_ANSWER",
      message: "The saved trigger scope answer is not a valid provider option.",
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/\bjson\b/i.test(text) && /response_format|prompt must contain/i.test(text)) {
    return {
      code: "BINDING_RESOLVER_PROVIDER_ERROR",
      message: "Binding resolver model rejected structured JSON output.",
    };
  }
  return {
    code: "BINDING_RESOLUTION_FAILED",
    message: "The workflow bindings could not be validated.",
  };
}

export type BindingResolutionResult = {
  artifact: z.infer<typeof bindingArtifactSchema>;
  raw: unknown;
};

export async function resolvePreparedBindings(
  prepared: Extract<PreparedBindingResolution, { ready: true }>,
  options?: {
    generate?: (input: { schema: z.ZodTypeAny; prompt: string; userId?: string }) => Promise<unknown>;
    userId?: string;
  },
): Promise<BindingResolutionResult> {
  const raw = options?.generate
    ? await options.generate({ schema: prepared.schema, prompt: prepared.prompt, userId: options?.userId })
    : buildResolvedPayload(prepared);
  const parsed = prepared.schema.parse(raw) as {
    actions: Record<string, string>;
    trigger: { outcomeId: string; connector: string; triggerSlug: string; config: Record<string, unknown> } | null;
  };

  const bindings: ToolBinding[] = prepared.selected.actions.map((action) => {
    const actionSlug = parsed.actions[action.outcomeId];
    if (actionSlug !== action.selected.actionSlug) {
      throw new Error(`Binding resolver returned an unavailable action for ${action.outcomeId}`);
    }
    return {
      connector: action.connector,
      capability: capabilityForAction(actionSlug),
      actionSlug,
      role: action.role,
    };
  });

  const selectedTrigger = prepared.selected.trigger;
  if (selectedTrigger && !parsed.trigger) throw new Error("Binding resolver omitted the workflow trigger");
  if (!selectedTrigger && parsed.trigger) throw new Error("Binding resolver invented a workflow trigger");
  if (selectedTrigger && parsed.trigger) {
    if (parsed.trigger.triggerSlug !== selectedTrigger.selected.slug
      || parsed.trigger.connector.toLowerCase() !== selectedTrigger.connector.toLowerCase()) {
      throw new Error("Binding resolver returned an unavailable trigger");
    }
    const validation = validateConfigAgainstSchema(selectedTrigger.selected.configSchema, parsed.trigger.config);
    if (!validation.ok) throw new Error(validation.error);
  }

  const artifact = bindingArtifactSchema.parse({
    trigger: parsed.trigger
      ? {
        kind: "event",
        source: parsed.trigger.connector,
        composioSlug: parsed.trigger.triggerSlug,
        config: parsed.trigger.config,
      }
      : { kind: "manual" },
    bindings,
    composioActions: [],
    output: { kind: "none" },
  });
  return { artifact, raw };
}

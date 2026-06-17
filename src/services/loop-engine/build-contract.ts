import Ajv from "ajv";
import { z } from "zod";

import { nextCronRunAt, validateFiveFieldCron } from "../loop-executor/cron.js";
import type { LoopIntentContext } from "./intent-context.js";
import type { ToolContract } from "../tool-spec/types.js";

const buildRequirementKindSchema = z.enum([
  "connector",
  "trigger_schedule",
  "stable_input",
  "grounding",
  "artifact_contract",
  "review_policy",
]);

const buildRequirementStatusSchema = z.enum(["unresolved", "resolved", "invalid"]);

const buildRequirementSchema = z.object({
  id: z.string().min(1),
  kind: buildRequirementKindSchema,
  question: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean().default(true),
  allowNone: z.boolean().default(false),
  valueSchema: z.record(z.unknown()),
  status: buildRequirementStatusSchema.default("unresolved"),
  value: z.unknown().optional(),
  provenance: z.object({
    source: z.enum(["user", "explicit_none", "legacy"]),
    resolvedAt: z.string().min(1),
  }).optional(),
  validationErrors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  triggerCapabilities: z.object({
    minimumScheduleMinutes: z.number().int().min(60),
    events: z.array(z.object({
      toolkit: z.string().min(1),
      slug: z.string().min(1),
      name: z.string().min(1),
      description: z.string(),
      type: z.enum(["webhook", "poll"]),
    })),
  }).optional(),
});

export const loopBuildContractSchema = z.object({
  version: z.literal("v1"),
  requirements: z.array(buildRequirementSchema),
  issues: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

type BuildRequirement = z.infer<typeof buildRequirementSchema>;
export type LoopBuildContract = z.infer<typeof loopBuildContractSchema>;
type SelectedLoopTrigger =
  | { mode: "schedule"; cron: string; timezone: string }
  | { mode: "event"; toolkit: string; triggerSlug: string };

export function selectedLoopTrigger(contract: LoopBuildContract): SelectedLoopTrigger | null {
  const requirement = contract.requirements.find((entry) => entry.kind === "trigger_schedule");
  if (!requirement?.value || typeof requirement.value !== "object" || Array.isArray(requirement.value)) return null;
  const value = requirement.value as Record<string, unknown>;
  if (value.trigger === "event" && typeof value.toolkit === "string" && typeof value.triggerSlug === "string") {
    return { mode: "event", toolkit: value.toolkit, triggerSlug: value.triggerSlug };
  }
  if (value.trigger === "schedule" && typeof value.cron === "string" && typeof value.timezone === "string") {
    return { mode: "schedule", cron: value.cron, timezone: value.timezone };
  }
  return null;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function toolkitFor(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? contract.name.toLowerCase();
}

function requirement(input: Omit<BuildRequirement, "status" | "validationErrors" | "warnings">): BuildRequirement {
  return buildRequirementSchema.parse({
    ...input,
    status: "unresolved",
    validationErrors: [],
    warnings: [],
  });
}

function reviewPolicyRequirement(): BuildRequirement {
  return requirement({
    id: "review_policy",
    kind: "review_policy",
    question: "How should external actions be reviewed?",
    reason: "External writes require an explicit build-time review policy in addition to per-run approval gates.",
    required: true,
    allowNone: false,
    valueSchema: objectSchema({
      mode: { type: "string", enum: ["draft_only", "approve_each_action", "approve_batch"] },
    }, ["mode"]),
  });
}

function connectorOperationalRequirements(contracts: ToolContract[]): BuildRequirement[] {
  return contracts.flatMap((contract) => Object.entries(contract.readiness?.fieldPolicies ?? {})
    .filter(([, policy]) => policy.required && policy.valuePolicy === "passthrough")
    .map(([path, policy]) => requirement({
      id: `connector_input:${String(contract.constraints.actionSlug ?? contract.name)}:${path}`,
      kind: "stable_input",
      question: policy.description?.trim() || `Provide the stable value for ${contract.name}: ${path}`,
      reason: "This connector action requires a stable operational value that cannot be safely derived from earlier workflow output or per-run context.",
      required: true,
      allowNone: false,
      valueSchema: objectSchema({
        toolRef: { const: contract.toolRef },
        path: { const: path },
        value: {},
      }, ["toolRef", "path", "value"]),
    })));
}

export function deriveLoopBuildContract(input: {
  intentContext: LoopIntentContext;
  discoveredToolContracts: ToolContract[];
  discoveredTriggers?: Array<{ toolkit: string; slug: string; name: string; description: string; type: "webhook" | "poll" }>;
  now?: string;
}): LoopBuildContract {
  const now = input.now ?? new Date().toISOString();
  const requirements: BuildRequirement[] = [];
  const connectorGroups = new Map<string, ToolContract[]>();
  for (const contract of input.discoveredToolContracts.filter((entry) => entry.provider === "composio")) {
    const toolkit = toolkitFor(contract);
    connectorGroups.set(toolkit, [...(connectorGroups.get(toolkit) ?? []), contract]);
  }

  if (connectorGroups.size > 0) {
    const contracts = [...connectorGroups.values()].flat();
    requirements.push(requirement({
      id: "connector_selection",
      kind: "connector",
      question: "Select and confirm the connected accounts and exact actions this loop may use.",
      reason: "The selected account and exact connector actions must be available before the workflow can be drafted.",
      required: true,
      allowNone: false,
      valueSchema: objectSchema({
        selections: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            toolkit: { type: "string", enum: [...connectorGroups.keys()] },
            accounts: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: objectSchema({
                id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
              }, ["id"]),
            },
            actionSlugs: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", enum: contracts.map((contract) => String(contract.constraints.actionSlug ?? contract.name)) },
            },
          }, ["toolkit", "accounts", "actionSlugs"]),
        },
      }, ["selections"]),
    }));
  }

  const discoveredTriggers = input.discoveredTriggers ?? [];
  requirements.push(requirement({
    id: "trigger_schedule",
    kind: "trigger_schedule",
    question: "How often should this loop check for new work?",
    reason: discoveredTriggers.length > 0
      ? "The connected apps support event-triggered execution or scheduled checks."
      : "The currently available connector capabilities support scheduled checks. Event-triggered execution is not available for this loop.",
    required: true,
    allowNone: false,
    valueSchema: {
      oneOf: [
        objectSchema({
          trigger: { const: "schedule" },
          cron: { type: "string" },
          timezone: { type: "string", minLength: 1 },
        }, ["trigger", "cron", "timezone"]),
        ...discoveredTriggers.map((trigger) => objectSchema({
          trigger: { const: "event" },
          toolkit: { const: trigger.toolkit },
          triggerSlug: { const: trigger.slug },
        }, ["trigger", "toolkit", "triggerSlug"])),
      ],
    },
    triggerCapabilities: {
      minimumScheduleMinutes: 60,
      events: discoveredTriggers,
    },
  }));

  for (const [index, label] of input.intentContext.analysis.normalizedIntent.runtimeInputs.entries()) {
    requirements.push(requirement({
      id: `stable_input:${index}`,
      kind: "stable_input",
      question: `Provide the stable workflow input: ${label}`,
      reason: "Stable operational inputs must be fixed at build time instead of being inferred on each run.",
      required: true,
      allowNone: false,
      valueSchema: objectSchema({
        name: { const: label },
        value: {},
      }, ["name", "value"]),
    }));
  }

  const hasExternalWrite = input.discoveredToolContracts.some((contract) =>
    contract.effect === "write_external" || contract.effect === "irreversible_external");
  const contentBearingIntent = input.intentContext.analysis.normalizedIntent.toolCategories.some((category) =>
    /communication|content|writing|research|knowledge|report|analysis/i.test(category));
  const producesMaterialContent = contentBearingIntent || hasExternalWrite
    || input.discoveredToolContracts.some((contract) =>
      contract.skillTags.some((tag) => ["draft", "summarize", "transform", "send"].includes(tag)));

  if (producesMaterialContent) {
    requirements.push(requirement({
      id: "grounding",
      kind: "grounding",
      question: "Which knowledge sources should ground this loop?",
      reason: "Tallei internal memory and active workspace memory are built-in (no setup URLs). Workspace memory includes outputs and preferences from prior loop runs in this workspace. Workspace FAQ and Google Docs are optional add-ons. Connected apps can optionally supply product or user records.",
      required: true,
      allowNone: true,
      valueSchema: objectSchema({
        mode: { type: "string", enum: ["sources", "none"] },
        sources: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["tallei_memory", "workspace_memory", "knowledge_base", "google_doc"] },
              id: { type: "string", minLength: 1 },
            },
            required: ["type"],
          },
        },
        externalDataToolkits: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      }, ["mode"]),
    }));

    requirements.push(requirement({
      id: "artifact_contract",
      kind: "artifact_contract",
      question: "What output structure or template should the loop follow?",
      reason: "Final and externally used outputs need an explicitly approved artifact contract.",
      required: true,
      allowNone: true,
      valueSchema: objectSchema({
        mode: { type: "string", enum: ["supplied_template", "approved_generated_structure", "none"] },
        template: { type: "string", minLength: 1 },
        structure: { type: "string", minLength: 1 },
      }, ["mode"]),
    }));
  }

  return loopBuildContractSchema.parse({ version: "v1", requirements, issues: [], createdAt: now, updatedAt: now });
}

function semanticErrors(requirement: BuildRequirement, value: unknown, contracts: ToolContract[]): string[] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (requirement.kind === "trigger_schedule") {
    if (record.trigger === "schedule") {
      if (typeof record.cron !== "string" || typeof record.timezone !== "string") {
        return ["A scheduled trigger requires a valid cron and timezone."];
      }
      try {
        const cron = validateFiveFieldCron(record.cron);
        new Intl.DateTimeFormat("en-US", { timeZone: record.timezone });
        let cursor = new Date("2026-01-01T00:00:00.000Z");
        for (let index = 0; index < 48; index += 1) {
          const next = nextCronRunAt(cron, cursor);
          if (next.getTime() - cursor.getTime() < 60 * 60 * 1000) {
            return ["Schedules must run no more often than once per hour."];
          }
          cursor = next;
        }
      } catch (error) {
        return [error instanceof Error ? error.message : "The schedule is invalid."];
      }
    }
  }
  if (requirement.kind === "connector") {
    const selections = Array.isArray(record.selections) ? record.selections : [];
    for (const selection of selections) {
      const selectedRecord = selection && typeof selection === "object" && !Array.isArray(selection)
        ? selection as Record<string, unknown>
        : {};
      const toolkit = String(selectedRecord.toolkit ?? "");
      const selected = Array.isArray(selectedRecord.actionSlugs) ? selectedRecord.actionSlugs.map(String) : [];
      const accounts = Array.isArray(selectedRecord.accounts) ? selectedRecord.accounts : [];
      if (accounts.length === 0) return [`Select at least one connected account for ${toolkit}.`];
      const invalidAccounts = accounts.filter((account) => {
        const value = account && typeof account === "object" && !Array.isArray(account)
          ? account as Record<string, unknown>
          : {};
        return typeof value.id !== "string";
      });
      if (invalidAccounts.length > 0) return [`The connected ${toolkit} account is invalid.`];
      const available = contracts.filter((contract) => toolkitFor(contract) === toolkit);
      if (available.length === 0) return [`The selected connector ${toolkit} was not discovered.`];
      const wrongToolkit = selected.filter((slug) =>
        !available.some((contract) => String(contract.constraints.actionSlug ?? contract.name) === slug));
      if (wrongToolkit.length > 0) return [`The selected actions do not belong to ${toolkit}: ${wrongToolkit.join(", ")}.`];
      const unavailable = available.filter((contract) =>
        selected.includes(String(contract.constraints.actionSlug ?? contract.name))
        && contract.constraints.connected !== true);
      if (unavailable.length > 0) return [`The selected connector actions are not connected: ${unavailable.map((entry) => entry.name).join(", ")}.`];
    }
  }
  if (requirement.kind === "grounding" && record.mode === "sources") {
    if (!Array.isArray(record.sources) || record.sources.length === 0) {
      return ["Grounding mode sources requires at least one source."];
    }
    const invalid = record.sources.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const source = entry as Record<string, unknown>;
      const type = source.type;
      if (type !== "tallei_memory" && type !== "workspace_memory" && type !== "knowledge_base" && type !== "google_doc") return true;
      if ((type === "knowledge_base" || type === "google_doc") && typeof source.id !== "string") return true;
      return false;
    });
    if (invalid) return ["Each grounding source must be a structured object with a supported type."];
    const externalToolkits = Array.isArray(record.externalDataToolkits) ? record.externalDataToolkits.map(String) : [];
    for (const toolkit of externalToolkits) {
      const normalized = toolkit.trim().toLowerCase();
      const searchRef = `composio.${normalized}.search`;
      const match = contracts.find((contract) => contract.toolRef.toLowerCase() === searchRef);
      if (!match) return [`External data toolkit ${toolkit} was not discovered as a connected search capability.`];
    }
  }
  if (requirement.kind === "artifact_contract" && record.mode === "supplied_template") {
    if (typeof record.template !== "string") {
      return ["A supplied template decision requires template content or a template reference."];
    }
    try {
      const bundle = JSON.parse(record.template) as { templates?: Array<{ html?: string }> };
      const templates = Array.isArray(bundle.templates) ? bundle.templates : [];
      if (templates.length === 0 || !templates.some((entry) => typeof entry.html === "string" && entry.html.trim().length > 0)) {
        return ["A supplied template decision requires at least one rendered email template with HTML."];
      }
    } catch {
      return ["The supplied template bundle must be valid JSON with rendered templates."];
    }
  }
  if (requirement.kind === "artifact_contract" && record.mode === "approved_generated_structure" && typeof record.structure !== "string") {
    return ["An approved generated structure decision requires the approved structure."];
  }
  return [];
}

export function resolveBuildRequirement(input: {
  contract: LoopBuildContract;
  requirementId: string;
  value: unknown;
  discoveredToolContracts: ToolContract[];
  now?: string;
}): LoopBuildContract {
  const parsed = loopBuildContractSchema.parse(input.contract);
  const target = parsed.requirements.find((entry) => entry.id === input.requirementId);
  if (!target) throw new Error(`Unknown build requirement: ${input.requirementId}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = ajv.compile(target.valueSchema);
  const valid = validator(input.value);
  const errors = [
    ...(valid ? [] : (ajv.errorsText(validator.errors, { separator: "; " }) ? [ajv.errorsText(validator.errors, { separator: "; " })] : ["Value does not match the required schema."])),
    ...semanticErrors(target, input.value, input.discoveredToolContracts),
  ];
  const now = input.now ?? new Date().toISOString();
  let requirements = parsed.requirements.map((entry): BuildRequirement => {
    if (entry.id !== target.id) return entry;
    if (errors.length > 0) return { ...entry, status: "invalid", value: input.value, validationErrors: errors };
    const record = input.value && typeof input.value === "object" && !Array.isArray(input.value) ? input.value as Record<string, unknown> : {};
    const explicitNone = record.mode === "none";
    return {
      ...entry,
      status: "resolved",
      value: input.value,
      provenance: { source: explicitNone ? "explicit_none" : "user", resolvedAt: now },
      validationErrors: [],
      warnings: explicitNone ? [`${entry.kind} was explicitly left unset by the user.`] : [],
    };
  });
  if (target.kind === "connector" && errors.length === 0) {
    const record = input.value && typeof input.value === "object" && !Array.isArray(input.value) ? input.value as Record<string, unknown> : {};
    const selected = new Set(Array.isArray(record.selections) ? record.selections.flatMap((selection) => {
      const selectedRecord = selection && typeof selection === "object" && !Array.isArray(selection)
        ? selection as Record<string, unknown>
        : {};
      return Array.isArray(selectedRecord.actionSlugs) ? selectedRecord.actionSlugs.map(String) : [];
    }) : []);
    const needsReview = input.discoveredToolContracts.some((contract) =>
      selected.has(String(contract.constraints.actionSlug ?? contract.name))
      && (contract.effect === "write_external" || contract.effect === "irreversible_external"));
    const existingReview = requirements.find((entry) => entry.kind === "review_policy");
    requirements = requirements.filter((entry) => entry.kind !== "review_policy");
    if (needsReview) requirements.push(existingReview ?? reviewPolicyRequirement());
    const selectedContracts = input.discoveredToolContracts.filter((contract) =>
      selected.has(String(contract.constraints.actionSlug ?? contract.name)));
    const existingRequirementIds = new Set(requirements.map((entry) => entry.id));
    requirements.push(...connectorOperationalRequirements(selectedContracts)
      .filter((entry) => !existingRequirementIds.has(entry.id)));
  }
  return loopBuildContractSchema.parse({ ...parsed, requirements, updatedAt: now });
}

export function unresolvedBuildRequirements(contract: LoopBuildContract): BuildRequirement[] {
  return loopBuildContractSchema.parse(contract).requirements.filter((entry) => entry.required && entry.status !== "resolved");
}

export function assertBuildContractReady(contract: LoopBuildContract | null | undefined): asserts contract is LoopBuildContract {
  if (!contract) throw new Error("A build contract is required before drafting the spec.");
  const unresolved = unresolvedBuildRequirements(contract);
  if (unresolved.length > 0) {
    throw new Error(`Build contract is not ready. Resolve: ${unresolved.map((entry) => entry.id).join(", ")}`);
  }
}

export function selectedConnectorAccountIds(
  contract: LoopBuildContract | null | undefined,
  toolkit: string,
): string[] {
  if (!contract) return [];
  const normalizedToolkit = toolkit.trim().toLowerCase();
  const requirement = contract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const selections = Array.isArray(value.selections) ? value.selections : [];
  const selection = selections.find((candidate) => {
    const record = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    return String(record.toolkit ?? "").trim().toLowerCase() === normalizedToolkit;
  });
  const record = selection && typeof selection === "object" && !Array.isArray(selection)
    ? selection as Record<string, unknown>
    : {};
  return Array.isArray(record.accounts) ? record.accounts.flatMap((account) => {
    const accountRecord = account && typeof account === "object" && !Array.isArray(account)
      ? account as Record<string, unknown>
      : {};
    return typeof accountRecord.id === "string" ? [accountRecord.id] : [];
  }) : [];
}

export function selectedConnectorAccountId(
  contract: LoopBuildContract | null | undefined,
  toolkit: string,
): string | undefined {
  const ids = selectedConnectorAccountIds(contract, toolkit);
  if (ids.length > 1) {
    throw new Error(`Connector action for ${toolkit} requires an explicit account-scoped route because multiple accounts are selected.`);
  }
  return ids[0];
}

export type ReviewPolicyMode = "draft_only" | "approve_each_action" | "approve_batch";

export function selectedReviewPolicy(contract: LoopBuildContract | null | undefined): ReviewPolicyMode | null {
  if (!contract) return null;
  const requirement = contract.requirements.find((entry) => entry.kind === "review_policy" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const mode = value.mode;
  if (mode === "draft_only" || mode === "approve_each_action" || mode === "approve_batch") {
    return mode;
  }
  return null;
}

export function selectedStableInputs(contract: LoopBuildContract | null | undefined): Record<string, string> {
  if (!contract) return {};
  const inputs: Record<string, string> = {};
  for (const requirement of contract.requirements) {
    if (requirement.kind !== "stable_input" || requirement.status !== "resolved") continue;
    const value = requirement.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
      ? requirement.value as Record<string, unknown>
      : {};
    const name = typeof value.name === "string" ? value.name : "";
    const resolved = typeof value.value === "string" ? value.value : String(value.value ?? "");
    if (name) inputs[name] = resolved;
  }
  return inputs;
}

export function selectedConnectorActionSlugs(contract: LoopBuildContract | null | undefined): string[] {
  if (!contract) return [];
  const requirement = contract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const selections = Array.isArray(value.selections) ? value.selections : [];
  const slugs = new Set<string>();
  for (const selection of selections) {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    const actionSlugs = Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String) : [];
    for (const slug of actionSlugs) {
      if (slug.trim()) slugs.add(slug);
    }
  }
  return [...slugs];
}

export type GroundingSourceRef =
  | { type: "tallei_memory" }
  | { type: "workspace_memory" }
  | { type: "knowledge_base"; id: string }
  | { type: "google_doc"; id: string };

export function selectedGroundingSources(contract: LoopBuildContract | null | undefined): GroundingSourceRef[] {
  if (!contract) return [];
  const requirement = contract.requirements.find((entry) => entry.id === "grounding" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  if (value.mode === "none") return [];
  if (value.mode !== "sources" || !Array.isArray(value.sources)) return [];
  const parsed: GroundingSourceRef[] = [];
  for (const entry of value.sources) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (type === "tallei_memory" || type === "workspace_memory") parsed.push({ type });
    else if ((type === "knowledge_base" || type === "google_doc") && typeof record.id === "string") {
      parsed.push({ type, id: record.id });
    }
  }
  return parsed;
}

export function selectedExternalDataToolkits(contract: LoopBuildContract | null | undefined): string[] {
  if (!contract) return [];
  const requirement = contract.requirements.find((entry) => entry.id === "grounding" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  if (value.mode === "none") return [];
  if (!Array.isArray(value.externalDataToolkits)) return [];
  return value.externalDataToolkits.map(String).filter((toolkit) => toolkit.trim().length > 0);
}

type RunnableArtifactTemplate = {
  id: string;
  name: string;
  templateId: string;
  designId?: string;
  subject: string;
  html: string;
  text?: string;
  reactEmailSource?: string;
  editorContent?: string;
};

type SelectedArtifactContract = {
  mode: string;
  designId?: string;
  templates: RunnableArtifactTemplate[];
  structure?: string;
};

export function selectedArtifactContract(
  contract: LoopBuildContract | null | undefined,
): SelectedArtifactContract | null {
  if (!contract) return null;
  const requirement = contract.requirements.find((entry) => entry.id === "artifact_contract" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const mode = typeof value.mode === "string" ? value.mode : "none";
  if (mode === "none") return { mode, templates: [] };
  if (mode === "approved_generated_structure") {
    return {
      mode,
      templates: [],
      ...(typeof value.structure === "string" ? { structure: value.structure } : {}),
    };
  }
  if (mode !== "supplied_template" || typeof value.template !== "string") return null;
  try {
    const bundle = JSON.parse(value.template) as {
      designId?: string;
      templates?: RunnableArtifactTemplate[];
    };
    const templates = Array.isArray(bundle.templates)
      ? bundle.templates.filter((entry) =>
          typeof entry?.id === "string"
          && typeof entry?.name === "string"
          && typeof entry?.subject === "string"
          && typeof entry?.html === "string")
      : [];
    return {
      mode,
      templates,
      ...(typeof bundle.designId === "string" ? { designId: bundle.designId } : {}),
    };
  } catch {
    return null;
  }
}

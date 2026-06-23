import Ajv from "ajv";
import { z } from "zod";

import { nextCronRunAt, validateFiveFieldCron } from "./schedule-cron.js";
import { isPlatformManagedToolkit } from "../../connectors/platform-integrations.js";
import type { LoopIntentContext } from "../contracts/intent-context.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { connectorAgentPlanSchema, type ConnectorAgentPlan } from "../contracts/connector-setup.js";

export const buildRequirementKindSchema = z.enum([
  "connector",
  "trigger_schedule",
  "stable_input",
  "grounding",
  "artifact_contract",
]);

export const buildRequirementStatusSchema = z.enum(["unresolved", "resolved", "invalid"]);

const buildRequirementSchema = z.object({
  id: z.string().min(1),
  kind: buildRequirementKindSchema,
  question: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  required: z.boolean().default(true),
  allowNone: z.boolean().default(false),
  valueSchema: z.record(z.unknown()).optional(),
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

const DEPRECATED_REQUIREMENT_KINDS = new Set(["review_policy", "output_review_gates"]);

function stripDeprecatedBuildContractRequirements(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = value as Record<string, unknown>;
  if (!Array.isArray(contract.requirements)) return value;
  return {
    ...contract,
    requirements: contract.requirements.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const kind = (entry as Record<string, unknown>).kind;
      return typeof kind !== "string" || !DEPRECATED_REQUIREMENT_KINDS.has(kind);
    }),
  };
}

export const loopBuildContractSchema = z.preprocess(stripDeprecatedBuildContractRequirements, z.object({
  version: z.literal("v1"),
  requirements: z.array(buildRequirementSchema),
  issues: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}));

/** Resolved build-contract snapshot persisted on workflows (no build-time metadata). */
export const persistedBuildRequirementSchema = z.object({
  id: z.string().min(1),
  kind: buildRequirementKindSchema,
  status: buildRequirementStatusSchema,
  value: z.unknown().optional(),
  provenance: z.object({
    source: z.enum(["user", "explicit_none", "legacy"]),
    resolvedAt: z.string().min(1),
  }).optional(),
});

export const persistedLoopBuildContractSchema = z.preprocess(stripDeprecatedBuildContractRequirements, z.object({
  version: z.literal("v1"),
  requirements: z.array(persistedBuildRequirementSchema),
  issues: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}));

export type PersistedLoopBuildContract = z.infer<typeof persistedLoopBuildContractSchema>;
export type AnyLoopBuildContract = LoopBuildContract | PersistedLoopBuildContract;

type BuildRequirement = z.infer<typeof buildRequirementSchema>;
export type LoopBuildContract = z.infer<typeof loopBuildContractSchema>;
type SelectedLoopTrigger =
  | { mode: "schedule"; cron: string; timezone: string }
  | { mode: "event"; toolkit: string; triggerSlug: string };

export function selectedLoopTrigger(contract: AnyLoopBuildContract): SelectedLoopTrigger | null {
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

function connectorSelectionRecords(contract: AnyLoopBuildContract | null | undefined): Record<string, unknown>[] {
  if (!contract) return [];
  const requirement = contract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  return Array.isArray(value.selections)
    ? value.selections.flatMap((selection) => {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) return [];
      return [selection as Record<string, unknown>];
    })
    : [];
}

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
    if (isPlatformManagedToolkit(toolkit)) continue;
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
        agentPlan: { type: "object" },
        testRun: { type: "object" },
        warnings: { type: "array", items: { type: "string" } },
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
        bundleRef: { type: "string", minLength: 1 },
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
    if (typeof record.bundleRef === "string" && record.bundleRef.trim().length > 0) {
      return [];
    }
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

export function normalizeConnectorResolveValue(requirementKind: string, value: unknown): unknown {
  if (requirementKind !== "connector") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.selections)) return value;
  if (typeof record.toolkit !== "string") return value;
  return {
    selections: [{
      toolkit: record.toolkit,
      accounts: Array.isArray(record.accounts) ? record.accounts : [],
      actionSlugs: Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String) : [],
    }],
  };
}

export function artifactContractValueIsComplete(value: unknown): boolean {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const mode = record.mode;
  if (mode === "none") return true;
  if (mode === "approved_generated_structure") {
    return typeof record.structure === "string" && record.structure.trim().length > 0;
  }
  if (mode === "supplied_template" && typeof record.bundleRef === "string" && record.bundleRef.trim().length > 0) {
    return true;
  }
  if (mode !== "supplied_template" || typeof record.template !== "string" || record.template.trim().length === 0) {
    return false;
  }
  try {
    const bundle = JSON.parse(record.template) as { templates?: Array<{ html?: string }> };
    const templates = Array.isArray(bundle.templates) ? bundle.templates : [];
    return templates.some((entry) => typeof entry.html === "string" && entry.html.trim().length > 0);
  } catch {
    return false;
  }
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

  const now = input.now ?? new Date().toISOString();
  if (
    target.kind === "artifact_contract"
    && target.status === "resolved"
    && artifactContractValueIsComplete(target.value)
    && !artifactContractValueIsComplete(input.value)
  ) {
    return loopBuildContractSchema.parse({ ...parsed, updatedAt: now });
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = ajv.compile(target.valueSchema ?? { type: "object" });
  const valid = validator(input.value);
  const errors = [
    ...(valid ? [] : (ajv.errorsText(validator.errors, { separator: "; " }) ? [ajv.errorsText(validator.errors, { separator: "; " })] : ["Value does not match the required schema."])),
    ...semanticErrors(target, input.value, input.discoveredToolContracts),
  ];
  let requirements = parsed.requirements.map((entry): BuildRequirement => {
    if (entry.id !== target.id) return entry;
    if (errors.length > 0) return { ...entry, status: "invalid", value: input.value, validationErrors: errors };
    const record = input.value && typeof input.value === "object" && !Array.isArray(input.value) ? input.value as Record<string, unknown> : {};
    const explicitNone = record.mode === "none";
    const { valueSchema: _valueSchema, triggerCapabilities: _triggerCapabilities, question: _question, reason: _reason, ...resolvedFields } = entry;
    return {
      ...resolvedFields,
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
    requirements = requirements.filter((entry) => !DEPRECATED_REQUIREMENT_KINDS.has(entry.kind));
    const selectedContracts = input.discoveredToolContracts.filter((contract) =>
      selected.has(String(contract.constraints.actionSlug ?? contract.name)));
    const existingRequirementIds = new Set(requirements.map((entry) => entry.id));
    requirements.push(...connectorOperationalRequirements(selectedContracts)
      .filter((entry) => !existingRequirementIds.has(entry.id)));
  }
  return loopBuildContractSchema.parse({ ...parsed, requirements, updatedAt: now });
}

export function isPersistedBuildContract(contract: AnyLoopBuildContract): contract is PersistedLoopBuildContract {
  return contract.requirements.some((requirement) => !("question" in requirement));
}

export function unresolvedBuildRequirements(contract: LoopBuildContract): BuildRequirement[] {
  return loopBuildContractSchema.parse(contract).requirements.filter((entry) => entry.required && entry.status !== "resolved");
}

export function slimUnresolvedRequirements(
  contract: LoopBuildContract,
): Array<{ id: string; kind: string; question: string }> {
  return unresolvedBuildRequirements(contract).map(({ id, kind, question }) => ({
    id,
    kind,
    question: question ?? `Resolve ${kind}`,
  }));
}

export function hydrateBuildContractArtifactBundle(
  contract: LoopBuildContract,
  artifactBundle: unknown,
): LoopBuildContract {
  if (artifactBundle == null) return contract;
  const template = typeof artifactBundle === "string" ? artifactBundle : JSON.stringify(artifactBundle);
  const requirements = contract.requirements.map((requirement) => {
    if (requirement.id !== "artifact_contract" || requirement.status !== "resolved") return requirement;
    const value = requirement.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
      ? requirement.value as Record<string, unknown>
      : {};
    if (value.mode !== "supplied_template" || typeof value.bundleRef !== "string") return requirement;
    return {
      ...requirement,
      value: { mode: "supplied_template", template },
    };
  });
  return loopBuildContractSchema.parse({ ...contract, requirements });
}

export function assertBuildContractReady(contract: AnyLoopBuildContract | null | undefined): asserts contract is AnyLoopBuildContract {
  if (!contract) throw new Error("A build contract is required before drafting the spec.");
  if (isPersistedBuildContract(contract)) {
    const unresolved = contract.requirements.filter((entry) => entry.status !== "resolved");
    if (unresolved.length > 0) {
      throw new Error(`Build contract is not ready. Resolve: ${unresolved.map((entry) => entry.id).join(", ")}`);
    }
    return;
  }
  const unresolved = unresolvedBuildRequirements(contract);
  if (unresolved.length > 0) {
    throw new Error(`Build contract is not ready. Resolve: ${unresolved.map((entry) => entry.id).join(", ")}`);
  }
}

export function selectedConnectorAccountIds(
  contract: AnyLoopBuildContract | null | undefined,
  toolkit: string,
): string[] {
  if (!contract) return [];
  const normalizedToolkit = toolkit.trim().toLowerCase();
  const selection = connectorSelectionRecords(contract).find((candidate) => String(candidate.toolkit ?? "").trim().toLowerCase() === normalizedToolkit);
  if (!selection) return [];
  return Array.isArray(selection.accounts) ? selection.accounts.flatMap((account) => {
    const accountRecord = account && typeof account === "object" && !Array.isArray(account)
      ? account as Record<string, unknown>
      : {};
    return typeof accountRecord.id === "string" ? [accountRecord.id] : [];
  }) : [];
}

export function selectedConnectorAccountId(
  contract: AnyLoopBuildContract | null | undefined,
  toolkit: string,
): string | undefined {
  const ids = selectedConnectorAccountIds(contract, toolkit);
  if (ids.length > 1) {
    throw new Error(`Connector action for ${toolkit} requires an explicit account-scoped route because multiple accounts are selected.`);
  }
  return ids[0];
}

export function selectedStableInputs(contract: AnyLoopBuildContract | null | undefined): Record<string, string> {
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

export function selectedConnectorSelections(
  contract: AnyLoopBuildContract | null | undefined,
): Array<{ toolkit: string; actionSlugs: string[] }> {
  return connectorSelectionRecords(contract).map((selection) => {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    const toolkit = typeof record.toolkit === "string" ? record.toolkit.trim().toLowerCase() : "";
    const actionSlugs = Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String).filter(Boolean) : [];
    return { toolkit, actionSlugs };
  }).filter((entry) => entry.toolkit && entry.actionSlugs.length > 0);
}

export function selectedConnectorActionSlugs(contract: AnyLoopBuildContract | null | undefined): string[] {
  if (!contract) return [];
  const slugs = new Set<string>();
  for (const selection of selectedConnectorSelections(contract)) {
    for (const actionSlug of selection.actionSlugs) {
      if (actionSlug.trim()) slugs.add(actionSlug);
    }
  }
  return [...slugs];
}

export function selectedConnectorAgentPlan(contract: AnyLoopBuildContract | null | undefined): ConnectorAgentPlan | null {
  if (!contract) return null;
  const requirement = contract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const agentPlan = value.agentPlan;
  if (!agentPlan) return null;
  return connectorAgentPlanSchema.parse(agentPlan);
}

export type GroundingSourceRef =
  | { type: "tallei_memory" }
  | { type: "workspace_memory" }
  | { type: "knowledge_base"; id: string }
  | { type: "google_doc"; id: string };

export function selectedGroundingSources(contract: AnyLoopBuildContract | null | undefined): GroundingSourceRef[] {
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

export function selectedExternalDataToolkits(contract: AnyLoopBuildContract | null | undefined): string[] {
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
  contract: AnyLoopBuildContract | null | undefined,
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
  if (mode !== "supplied_template") return null;
  if (typeof value.template !== "string") {
    if (typeof value.designId === "string" && value.designId.trim()) {
      return { mode, designId: value.designId.trim(), templates: [] };
    }
    return null;
  }
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

export function slimBuildContractForPersistence(contract: LoopBuildContract): PersistedLoopBuildContract {
  const parsed = loopBuildContractSchema.parse(contract);
  return persistedLoopBuildContractSchema.parse({
    version: parsed.version,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    issues: parsed.issues.length > 0 ? parsed.issues : [],
    requirements: parsed.requirements.map((requirement) => ({
      id: requirement.id,
      kind: requirement.kind,
      status: requirement.status,
      ...(requirement.value !== undefined
        ? { value: requirement.value }
        : {}),
      ...(requirement.provenance ? { provenance: requirement.provenance } : {}),
    })),
  });
}

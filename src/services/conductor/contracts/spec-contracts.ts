import { z } from "zod";

import { dataContractSchema, normalizeContractSchema } from "./data-contract.js";
import {
  dataInputSurfaceSchema,
  inputRequirementSchema,
  normalizeSpecInputRequirements,
  reviewSurfaceSchema,
} from "./input-surfaces.js";
import { loopIntentContextSchema } from "./intent-context.js";
import { loopBuildContractSchema } from "../domain/build-contract.js";

function filterEmptyStrings(arr: unknown): unknown {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
}

/** LLMs often emit "" for optional fields; Zod optional() accepts undefined, not empty strings. */
function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSchedule(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const schedule = value as Record<string, unknown>;
  const description = typeof schedule.description === "string" ? schedule.description.trim() : schedule.description;
  const cron = emptyStringToUndefined(schedule.cron);
  const timezone = emptyStringToUndefined(schedule.timezone);
  const normalized: Record<string, unknown> = { ...schedule, description };
  if (cron !== undefined) normalized.cron = cron;
  else delete normalized.cron;
  if (timezone !== undefined) normalized.timezone = timezone;
  else delete normalized.timezone;
  return normalized;
}

function normalizeSpecDelivery(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === "string" ? row.provider.trim() : "";
  if (provider) return row;
  const legacyTarget = typeof row.target === "string" ? row.target.trim().toLowerCase() : "none";
  return {
    ...row,
    provider: legacyTarget === "none" ? "none" : "none",
  };
}

export const agentPersonaRoleKeySchema = z.enum([
  "researcher",
  "analyst",
  "classifier",
  "marketer",
  "writer",
  "engineer",
  "reviewer",
  "publisher",
  "coordinator",
  "generalist",
]);

export const agentPersonaSchema = z.object({
  displayName: z.string().min(1).trim(),
  roleKey: agentPersonaRoleKeySchema,
  roleLabel: z.string().min(1).trim(),
  avatarId: z.string().uuid(),
  avatarSeed: z.string().min(1).trim(),
});

function parseJsonObjectField(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAgentContract(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = { ...(value as Record<string, unknown>) };
  contract.schema = normalizeContractSchema(parseJsonObjectField(contract.schema));
  if (contract.mediaType === null) delete contract.mediaType;
  if (contract.visibility === null) delete contract.visibility;
  if (contract.renderer === null) delete contract.renderer;
  return contract;
}

const noSlopSpecAgentInputContractSchema = z.object({
  description: z.string().min(1),
  schema: z.record(z.unknown()).default({}),
});

const noSlopSpecAgentHandoffBindingSchema = z.object({
  source: z.object({
    kind: z.enum(["agent_output", "operator_input", "stable_config", "artifact"]),
    agentId: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    path: z.string().min(1).default("/"),
  }),
  targetPath: z.string().min(1),
  required: z.boolean().default(true),
  valuePolicy: z.enum(["derivable", "passthrough"]).optional(),
  provenance: z.enum(["agent_output", "operator_input", "stable_config", "artifact", "connector_output"]).optional(),
  transformation: z.enum(["direct", "merge", "transform"]).default("direct").optional(),
});

function normalizeLegacyGate(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const gate = { ...(value as Record<string, unknown>) };
  const type = typeof gate.type === "string" ? gate.type.trim().toLowerCase() : "";
  if (type === "input" || type === "approval") return gate;
  if (type === "missing_input") {
    return {
      ...gate,
      type: "input",
      input: {
        surface: typeof gate.surface === "string" ? gate.surface : "input.text",
        key: typeof gate.key === "string" ? gate.key : "operator_input",
      },
    };
  }
  const surface = type === "pre_send"
    ? "confirm.send"
    : type === "source_confirmation"
      ? "review.sources"
      : type === "memory_confirmation"
        ? "review.memories"
        : type === "preview_review"
          ? "review.preview"
          : "review.draft";
  return {
    ...gate,
    type: "approval",
    approval: {
      surface,
      ...(typeof gate.artifactKey === "string" ? { artifactKey: gate.artifactKey } : {}),
      ...(typeof gate.actionRef === "string" ? { actionRef: gate.actionRef } : {}),
      ...(gate.payload && typeof gate.payload === "object" && !Array.isArray(gate.payload) ? { payload: gate.payload } : {}),
    },
  };
}

export const canonicalInputGateSchema = z.object({
  type: z.literal("input"),
  question: z.string().min(1),
  input: z.object({
    surface: dataInputSurfaceSchema.default("input.text"),
    key: z.string().min(1).default("operator_input"),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  }).default({
    surface: "input.text",
    key: "operator_input",
  }),
});

export const canonicalApprovalGateSchema = z.object({
  type: z.literal("approval"),
  question: z.string().min(1),
  approval: z.object({
    surface: reviewSurfaceSchema.optional(),
    artifactKey: z.string().min(1).optional(),
    actionRef: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    payload: z.record(z.unknown()).optional(),
  }).default({}),
});

export const noSlopSpecAgentGateSchema = z.preprocess(
  normalizeLegacyGate,
  z.discriminatedUnion("type", [
    canonicalInputGateSchema,
    canonicalApprovalGateSchema,
  ]),
);

function normalizeLegacyArtifactRole(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const agent = { ...(value as Record<string, unknown>) };
  const role = typeof agent.artifactRole === "string" ? agent.artifactRole : "";
  delete agent.artifactRole;
  if (!agent.outputContract || typeof agent.outputContract !== "object" || Array.isArray(agent.outputContract)) {
    return agent;
  }
  const outputContract = { ...(agent.outputContract as Record<string, unknown>) };
  if (!outputContract.renderer) {
    if (role === "draft_body") outputContract.renderer = "canvas.email";
    if (role === "final_preview") outputContract.renderer = "canvas.preview";
  }
  agent.outputContract = outputContract;
  return agent;
}

export const noSlopSpecAgentSchema = z.preprocess(normalizeLegacyArtifactRole, z.object({
  nodeKind: z.enum(["agent", "transform", "operator_input", "action", "checkpoint"]).optional(),
  name: z.string().min(1).trim(),
  goal: z.string().min(1).trim(),
  tools: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  guardrails: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  doneWhen: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  doneCriteria: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).optional(),
  failureModes: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  inputContract: z.preprocess(normalizeAgentContract, noSlopSpecAgentInputContractSchema).optional(),
  outputContract: z.preprocess(normalizeAgentContract, dataContractSchema).optional(),
  handoffBindings: z.array(noSlopSpecAgentHandoffBindingSchema).default([]),
  gate: noSlopSpecAgentGateSchema.optional(),
  persona: agentPersonaSchema.optional(),
}));

const connectorActionRiskSchema = z.enum(["read", "write", "send", "destructive"]);

function normalizeConnectorActionRef(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.trim();
    const composioMatch = s.match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
    if (composioMatch) {
      return { toolkit: composioMatch[1].trim(), actionSlug: composioMatch[2].trim(), risk: "send" };
    }
    const dotIdx = s.indexOf(".");
    if (dotIdx > 0) {
      return { toolkit: s.slice(0, dotIdx).trim(), actionSlug: s.slice(dotIdx + 1).trim(), risk: "send" };
    }
    return { toolkit: s, actionSlug: s, risk: "send" };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const toolkit = typeof obj.toolkit === "string" ? obj.toolkit.trim() : "";
    const actionSlug = typeof obj.actionSlug === "string" ? obj.actionSlug.trim() : "";
    const risk = typeof obj.risk === "string" ? obj.risk.trim() : "";
    if (actionSlug.includes(".action.")) {
      return normalizeConnectorActionRef(actionSlug);
    }
    if (toolkit.includes(".action.") && !actionSlug) {
      return normalizeConnectorActionRef(toolkit);
    }
    if (!toolkit && !actionSlug) {
      const ref = typeof obj.ref === "string" ? obj.ref.trim() : typeof obj.action === "string" ? obj.action.trim() : "";
      if (ref) {
        return normalizeConnectorActionRef(ref);
      }
    }
    const inferredToolkit = toolkit.toLowerCase() === "composio"
      ? actionSlug.replace(/^_+/, "").split("_")[0]?.trim()
      : undefined;
    return {
      toolkit: inferredToolkit || toolkit || undefined,
      actionSlug: actionSlug || undefined,
      risk: risk || undefined,
      description: typeof obj.description === "string" ? obj.description.trim() : obj.description,
      requiresPreSendApproval: obj.requiresPreSendApproval,
    };
  }
  return value;
}

const baseConnectorActionPolicySchema = z.object({
  toolkit: z.string().min(1).trim(),
  actionSlug: z.string().min(1).trim(),
  risk: connectorActionRiskSchema,
  description: z.preprocess(emptyStringToUndefined, z.string().min(1).trim().optional()),
  requiresPreSendApproval: z.boolean().default(true),
});

const connectorActionPolicySchema = z.preprocess(
  normalizeConnectorActionRef,
  baseConnectorActionPolicySchema,
);

export const connectorPolicySchema = z.object({
  allowedReadActions: z.array(connectorActionPolicySchema).default([]),
  allowedWriteActions: z.array(connectorActionPolicySchema).default([]),
}).superRefine((policy, ctx) => {
  for (const action of policy.allowedWriteActions) {
    if (action.risk === "read") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedWriteActions"],
        message: "Write action policies cannot be classified as read.",
      });
    }
    if (!action.requiresPreSendApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedWriteActions", action.actionSlug],
        message: "Mutating connector actions require per-run pre-send approval.",
      });
    }
  }
});

const baseNoSlopSpecSchema = z.object({
  purpose: z.string().min(1).trim(),
  agents: z.array(noSlopSpecAgentSchema).min(1),
  guardrails: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  successCriteria: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  failureModes: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  schedule: z.preprocess(normalizeSchedule, z.object({
    description: z.string().min(1).trim(),
    cron: z.string().min(1).trim().optional(),
    timezone: z.string().min(1).trim().optional(),
  })),
  delivery: z.preprocess(normalizeSpecDelivery, z.object({
    provider: z.string().min(1).trim().default("none"),
    description: z.preprocess(emptyStringToUndefined, z.string().min(1).trim().default("Dashboard only")),
  })),
  connectorPolicy: connectorPolicySchema.default({
    allowedReadActions: [],
    allowedWriteActions: [],
  }),
  inputRequirements: z.array(inputRequirementSchema).default([]),
  buildContract: loopBuildContractSchema.optional(),
});

const approvedNoSlopSpecSchema = baseNoSlopSpecSchema;
const draftNoSlopSpecSchema = baseNoSlopSpecSchema;

function preprocessNoSlopSpec(value: unknown): unknown {
  return normalizeSpecInputRequirements(
    normalizeSchedule(value),
  );
}

export const noSlopSpecDraftSchema = z.preprocess(
  preprocessNoSlopSpec,
  draftNoSlopSpecSchema,
);

export const noSlopSpecSchema = z.preprocess(
  preprocessNoSlopSpec,
  approvedNoSlopSpecSchema,
);

export const noSlopSpecStatusSchema = z.enum(["draft", "approved", "archived"]);

export const noSlopSpecSnapshotSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  version: z.number().int().min(1),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  specJson: noSlopSpecDraftSchema,
  intentContext: loopIntentContextSchema.optional(),
  buildContract: loopBuildContractSchema.optional(),
  approvedAt: z.string().min(1),
});

export type AgentPersonaRoleKey = z.infer<typeof agentPersonaRoleKeySchema>;
export type AgentPersona = z.infer<typeof agentPersonaSchema>;
export type NoSlopSpec = z.infer<typeof noSlopSpecSchema>;
export type NoSlopSpecAgent = z.infer<typeof noSlopSpecAgentSchema>;
export type NoSlopSpecStatus = z.infer<typeof noSlopSpecStatusSchema>;
export type NoSlopSpecSnapshot = z.infer<typeof noSlopSpecSnapshotSchema>;
type ConnectorActionPolicy = z.infer<typeof connectorActionPolicySchema>;
export type ConnectorActionRisk = z.infer<typeof connectorActionRiskSchema>;
type ConnectorPolicy = z.infer<typeof connectorPolicySchema>;

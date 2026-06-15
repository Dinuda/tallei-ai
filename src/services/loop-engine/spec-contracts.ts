import { z } from "zod";

import { inputRequirementSchema, normalizeSpecInputRequirements } from "./input-surfaces.js";
import { loopIntentContextSchema } from "./intent-context.js";
import { loopBuildContractSchema } from "./build-contract.js";

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

export const noSlopSpecAgentSchema = z.object({
  name: z.string().min(1).trim(),
  goal: z.string().min(1).trim(),
  guardrails: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  doneWhen: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  failureModes: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
});

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

export type NoSlopSpec = z.infer<typeof noSlopSpecSchema>;
export type NoSlopSpecAgent = z.infer<typeof noSlopSpecAgentSchema>;
export type NoSlopSpecStatus = z.infer<typeof noSlopSpecStatusSchema>;
export type NoSlopSpecSnapshot = z.infer<typeof noSlopSpecSnapshotSchema>;
type ConnectorActionPolicy = z.infer<typeof connectorActionPolicySchema>;
export type ConnectorActionRisk = z.infer<typeof connectorActionRiskSchema>;
type ConnectorPolicy = z.infer<typeof connectorPolicySchema>;

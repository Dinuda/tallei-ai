import { z } from "zod";

const SUBSCRIBER_ALIAS_KEYWORDS = [
  "mailing_list",
  "subscriber",
  "email_list",
  "contact_list",
  "contacts_list",
  "audience",
  "resend",
] as const;

function normalizeDeliveryTarget(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  // Composio action refs masquerading as delivery targets (e.g. "composio.resend.action.resend_send_email")
  if (normalized.includes("composio.") && normalized.includes(".action.")) {
    if (normalized.includes("email") || normalized.includes("mail") || normalized.includes("send")) {
      return "subscriber_list";
    }
    return "none";
  }
  if (SUBSCRIBER_ALIAS_KEYWORDS.some((kw) => normalized.includes(kw))) {
    return "subscriber_list";
  }
  return normalized;
}

export const noSlopSpecDeliveryTargetSchema = z.preprocess(normalizeDeliveryTarget, z.enum([
  "subscriber_list",
  "team_email",
  "operator",
  "none",
]));

function filterEmptyStrings(arr: unknown): unknown {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
}

export const noSlopSpecAgentSchema = z.object({
  name: z.string().min(1).trim(),
  goal: z.string().min(1).trim(),
  guardrails: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  doneWhen: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  failureModes: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
});

export const connectorActionRiskSchema = z.enum(["read", "write", "send", "destructive"]);

function normalizeConnectorActionRef(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.trim();
    // e.g. "composio.gmail.action.send_email" -> { toolkit: "gmail", actionSlug: "send_email" }
    const composioMatch = s.match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
    if (composioMatch) {
      return { toolkit: composioMatch[1].trim(), actionSlug: composioMatch[2].trim(), risk: "send" };
    }
    // e.g. "gmail.send_email"
    const dotIdx = s.indexOf(".");
    if (dotIdx > 0) {
      return { toolkit: s.slice(0, dotIdx).trim(), actionSlug: s.slice(dotIdx + 1).trim(), risk: "send" };
    }
    // e.g. a single slug -> use as both; pair may be refined later
    return { toolkit: s, actionSlug: s, risk: "send" };
  }
  // Handle object with missing/empty fields
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const toolkit = typeof obj.toolkit === "string" ? obj.toolkit.trim() : "";
    const actionSlug = typeof obj.actionSlug === "string" ? obj.actionSlug.trim() : "";
    const risk = typeof obj.risk === "string" ? obj.risk.trim() : "";
    // If both are empty, try to extract from a "ref" or "action" field
    if (!toolkit && !actionSlug) {
      const ref = typeof obj.ref === "string" ? obj.ref.trim() : typeof obj.action === "string" ? obj.action.trim() : "";
      if (ref) {
        return normalizeConnectorActionRef(ref);
      }
    }
    // Return normalized object (will fail validation if still missing, but with clear path)
    return {
      toolkit: toolkit || undefined,
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
  description: z.string().min(1).trim().optional(),
  requiresPreSendApproval: z.boolean().default(true),
});

export const connectorActionPolicySchema = z.preprocess(
  normalizeConnectorActionRef,
  baseConnectorActionPolicySchema,
);

function normalizeRecipientSourceKind(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim().toLowerCase().replace(/\s+/g, "_");
  // Keyword-based matching for LLM variants
  if (s.includes("operator") || s.includes("user_provided") || s.includes("manual_input") || s.includes("user_input")) {
    return "operator_input";
  }
  if (s.includes("uploaded") || s.includes("file") || s.includes("csv") || s.includes("spreadsheet")) {
    return "uploaded";
  }
  if (s.includes("configured") || s.includes("config") || s.includes("connection") || s.includes("connected") || s.includes("external") || s.includes("subscriber")) {
    return "configured";
  }
  if (s.includes("none") || s === "null" || s === "") {
    return "none";
  }
  return s;
}

export const connectorRecipientSourceSchema = z.object({
  kind: z.preprocess(normalizeRecipientSourceKind, z.enum(["none", "configured", "uploaded", "operator_input"])).default("none"),
  description: z.string().min(1).trim().optional(),
});

export const approvedInternalToolsSchema = z.object({
  readToolRefs: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default(["internal.web_search", "internal.memory_search"]),
  writeToolRefs: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default(["internal.llm_only"]),
});

export type ApprovedInternalTools = z.infer<typeof approvedInternalToolsSchema>;

export const connectorPolicySchema = z.object({
  enabledToolkits: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  approvedInternalTools: approvedInternalToolsSchema.default({ readToolRefs: ["internal.web_search", "internal.memory_search"], writeToolRefs: ["internal.llm_only"] }),
  approvedComposioToolkits: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  allowedReadActions: z.array(connectorActionPolicySchema).default([]),
  allowedWriteActions: z.array(connectorActionPolicySchema).default([]),
  recipientSource: connectorRecipientSourceSchema.default({ kind: "none" }),
  deliveryExpectation: z.string().min(1).trim().default("No outbound delivery."),
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

function connectorActionRefText(action: { toolkit: string; actionSlug: string; description?: string }): string {
  return `${action.toolkit} ${action.actionSlug} ${action.description ?? ""}`.toLowerCase();
}

function isDraftOnlyConnectorAction(action: { toolkit: string; actionSlug: string; description?: string }): boolean {
  const text = connectorActionRefText(action);
  return /\bdraft\b|create[_-]?draft|email[_-]?draft/.test(text);
}

export const noSlopSpecSchema = z.object({
  purpose: z.string().min(1).trim(),
  agents: z.array(noSlopSpecAgentSchema).min(1),
  guardrails: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  successCriteria: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  failureModes: z.preprocess(filterEmptyStrings, z.array(z.string().min(1))).default([]),
  schedule: z.object({
    description: z.string().min(1).trim(),
    cron: z.string().min(1).trim().optional(),
    timezone: z.string().min(1).trim().optional(),
  }),
  delivery: z.object({
    target: noSlopSpecDeliveryTargetSchema.default("none"),
    description: z.string().min(1).trim().default("Dashboard only"),
  }),
  connectorPolicy: connectorPolicySchema.default({
    enabledToolkits: [],
    approvedInternalTools: { readToolRefs: ["internal.web_search", "internal.memory_search"], writeToolRefs: ["internal.llm_only"] },
    approvedComposioToolkits: [],
    allowedReadActions: [],
    allowedWriteActions: [],
    recipientSource: { kind: "none" },
    deliveryExpectation: "No outbound delivery.",
  }),
}).superRefine((spec, ctx) => {
  if (spec.delivery.target !== "none") {
    if (spec.connectorPolicy.allowedWriteActions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectorPolicy", "allowedWriteActions"],
        message: "Outbound delivery requires at least one explicitly approved connector write action.",
      });
    }
    if (spec.connectorPolicy.allowedWriteActions.some((action) => !action.requiresPreSendApproval)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectorPolicy", "allowedWriteActions"],
        message: "Outbound delivery requires per-run pre-send approval.",
      });
    }
    if (spec.delivery.target === "subscriber_list") {
      for (const action of spec.connectorPolicy.allowedWriteActions) {
        if (action.risk !== "send") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["connectorPolicy", "allowedWriteActions", action.actionSlug],
            message: "Subscriber-list delivery requires a send-capable connector action.",
          });
        }
        if (isDraftOnlyConnectorAction(action)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["connectorPolicy", "allowedWriteActions", action.actionSlug],
            message: "Subscriber-list delivery cannot use draft-only connector actions.",
          });
        }
      }
    }
  }
});

export const noSlopSpecStatusSchema = z.enum(["draft", "approved", "archived"]);

export const noSlopSpecSnapshotSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  version: z.number().int().min(1),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  specJson: noSlopSpecSchema,
  approvedAt: z.string().min(1),
});

export type NoSlopSpec = z.infer<typeof noSlopSpecSchema>;
export type NoSlopSpecAgent = z.infer<typeof noSlopSpecAgentSchema>;
export type NoSlopSpecStatus = z.infer<typeof noSlopSpecStatusSchema>;
export type NoSlopSpecSnapshot = z.infer<typeof noSlopSpecSnapshotSchema>;
export type ConnectorActionPolicy = z.infer<typeof connectorActionPolicySchema>;
export type ConnectorActionRisk = z.infer<typeof connectorActionRiskSchema>;
export type ConnectorPolicy = z.infer<typeof connectorPolicySchema>;

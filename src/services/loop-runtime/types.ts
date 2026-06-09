import { z } from "zod";

import { loopDefinitionSchema, loopRunAgentSchema } from "../loop-executor/types.js";

export const runtimeRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_gate",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runtimeCommandTypeSchema = z.enum([
  "start_run",
  "execute_step",
  "continue_after_gate",
  "finalize_run",
  "retry_step",
]);

export const approvedWebSourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  snippet: z.string().min(1),
});

export const operatorRevisionSchema = z.object({
  feedback: z.string().optional(),
  editedText: z.string().optional(),
  at: z.string().min(1),
});

export const runtimeContextSchema = z.object({
  inputs: z.record(z.string()).default({}),
  approvedMemories: z.array(z.object({ id: z.string(), excerpt: z.string() })).default([]),
  approvedSources: z.record(z.array(approvedWebSourceSchema)).default({}),
  operatorRevisions: z.record(operatorRevisionSchema).default({}),
});

export const runtimeDefinitionSchema = loopDefinitionSchema.superRefine((definition, ctx) => {
  const engineVersion = definition.engineVersion ?? definition.builderMeta?.engineVersion;
  if (engineVersion !== "loop_engine_v3") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only loop_engine_v3 definitions can run" });
  }
  if (!definition.agentGraph?.children.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A v3 run requires at least one child agent" });
  }
  if (definition.plan || definition.presetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Legacy plans and presets are not supported" });
  }
  if (definition.delivery && (definition.delivery.target !== "none" || definition.delivery.provider !== "none")) {
    if (!definition.connectorPolicy || definition.connectorPolicy.allowedWriteActions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outbound delivery requires an approved connector policy" });
    }
  }
  const approvedWriteActions = definition.connectorPolicy?.allowedWriteActions ?? [];
  const approvedWriteRefs = new Set(approvedWriteActions.map((action) =>
    `composio.${action.toolkit.toLowerCase()}.action.${action.actionSlug.toLowerCase()}`
  ));
  if (definition.delivery?.target === "subscriber_list") {
    const provider = definition.delivery.provider.toLowerCase();
    const selected = approvedWriteActions.find((action) =>
      `composio.${action.toolkit.toLowerCase()}.action.${action.actionSlug.toLowerCase()}` === provider
    );
    const selectedText = selected ? `${selected.toolkit} ${selected.actionSlug} ${selected.description ?? ""}`.toLowerCase() : "";
    if (!selected || selected.risk !== "send" || /\bdraft\b|create[_ -]?draft|email[_ -]?draft/.test(selectedText)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Subscriber-list delivery requires an approved send-capable connector action",
      });
    }
  }
  for (const agent of definition.agentGraph?.children ?? []) {
    for (const tool of agent.tools) {
      if (tool.ref === "canvas.email") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "canvas.email is a render target, not an agent tool",
        });
      }
      const normalizedRef = tool.ref.toLowerCase();
      if (tool.ref === "internal.resend_broadcast" || tool.ref === "internal.email_approval_request") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Outbound tool ${tool.ref} is disabled in the stable runtime`,
        });
      }
      if (/^composio\.[a-z0-9_-]+\.action\./.test(normalizedRef) && !approvedWriteRefs.has(normalizedRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Connector action ${tool.ref} is not approved by this workflow's connector policy`,
        });
      }
    }
    const hasApprovedWrite = agent.tools.some((tool) => approvedWriteRefs.has(tool.ref.toLowerCase()));
    if (hasApprovedWrite && agent.gate?.type !== "pre_send") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Approved connector actions require a pre_send gate" });
    }
    if (agent.gate?.type === "pre_send" && !hasApprovedWrite) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pre_send gates require an approved connector action" });
    }
  }
});

export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type RuntimeAgent = z.infer<typeof loopRunAgentSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;

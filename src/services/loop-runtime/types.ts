import { z } from "zod";

import { loopContactRowSchema, loopDefinitionSchema, loopRunAgentSchema } from "../loop-executor/types.js";
import { connectorActionToolRef, getStaticToolContract } from "../tool-spec/tool-contracts.js";

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

export const runtimeDeliveryRecipientsSchema = z.object({
  uploadedAt: z.string().min(1),
  contacts: z.array(loopContactRowSchema),
  recipientCount: z.number().int().nonnegative(),
  source: z.enum(["uploaded", "configured", "operator_input"]).optional(),
  audienceId: z.string().min(1).optional(),
  documentRef: z.string().min(1).optional(),
  lotRef: z.string().min(1).optional(),
});

import { workflowUserProfileSchema } from "../loop-engine/workflow-user-profile.js";

export const runtimeContextSchema = z.object({
  inputs: z.record(z.string()).default({}),
  approvedMemories: z.array(z.object({ id: z.string(), excerpt: z.string() })).default([]),
  approvedSources: z.record(z.array(approvedWebSourceSchema)).default({}),
  operatorRevisions: z.record(operatorRevisionSchema).default({}),
  deliveryRecipients: runtimeDeliveryRecipientsSchema.optional(),
  userProfile: workflowUserProfileSchema.optional(),
});

function approvedConnectorToolRefs(action: { toolkit: string; actionSlug: string }): string[] {
  return [connectorActionToolRef(action)];
}

export const runtimeDefinitionSchema = loopDefinitionSchema.superRefine((definition, ctx) => {
  const engineVersion = definition.engineVersion ?? definition.builderMeta?.engineVersion;
  if (engineVersion !== "loop_engine_v3") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only loop_engine_v3 definitions can run" });
  }
  if (!definition.agentGraph?.children.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A v3 run requires at least one child agent" });
  }
  if (definition.plan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Legacy plans are not supported" });
  }
  if (definition.delivery && (definition.delivery.target !== "none" || definition.delivery.provider !== "none")) {
    if (!definition.connectorPolicy || definition.connectorPolicy.allowedWriteActions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outbound delivery requires an approved connector policy" });
    }
  }
  const approvedWriteActions = definition.connectorPolicy?.allowedWriteActions ?? [];
  const approvedWriteRefs = new Set(approvedWriteActions.flatMap(approvedConnectorToolRefs));
  for (const agent of definition.agentGraph?.children ?? []) {
    const agentToolContracts = agent.tools.map((tool) => ({ tool, contract: getStaticToolContract(tool.ref) }));
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
      const contract = getStaticToolContract(tool.ref);
      if (contract?.approval.required && !approvedWriteRefs.has(normalizedRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Connector action ${tool.ref} is not approved by this workflow's connector policy`,
        });
      }
    }
    const approvalContract = agentToolContracts.find((item) => item.contract?.approval.required)?.contract;
    const hasApprovedWrite = agentToolContracts.some((item) => approvedWriteRefs.has(item.tool.ref.toLowerCase()));
    if (approvalContract && !hasApprovedWrite) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External-effect tools require an approved connector policy action" });
    }
    if (approvalContract && (!agent.gate || (approvalContract.approval.suggestedGate && agent.gate.type !== approvalContract.approval.suggestedGate))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External-effect tools require their contract approval gate" });
    }
    if (agent.gate?.type === "pre_send" && !approvalContract) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pre_send gates require a tool contract that needs external approval" });
    }
  }
});

export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type RuntimeAgent = z.infer<typeof loopRunAgentSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;

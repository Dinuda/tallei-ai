import { z } from "zod";

import { workflowUserProfileSchema } from "../loop-engine/workflow-user-profile.js";
import { loopContactRowSchema, loopDefinitionSchema, loopRunAgentSchema } from "../loop-executor/types.js";
import { connectorActionToolRef, getStaticToolContract } from "../tool-spec/tool-contracts.js";

export const runtimeRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_interaction",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runtimeCommandTypeSchema = z.enum([
  "start_run",
  "execute_step",
  "continue_after_interaction",
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
  const hasConnectorActions = (definition.agentGraph?.children ?? []).some((agent) =>
    agent.tools.some((tool) => /^composio\.[a-z0-9_-]+\.action\./.test(tool.ref.toLowerCase())));
  if (!definition.builderMeta?.planningIR) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow requires a model-planned, contract-validated planning IR.",
    });
  }
  if (definition.delivery && definition.delivery.provider !== "none") {
    if (!definition.connectorPolicy || definition.connectorPolicy.allowedWriteActions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outbound delivery requires an approved connector policy" });
    }
  }
  const approvedWriteActions = definition.connectorPolicy?.allowedWriteActions ?? [];
  const approvedWriteRefs = new Set(approvedWriteActions.flatMap(approvedConnectorToolRefs));
  const approvedReadRefs = new Set((definition.connectorPolicy?.allowedReadActions ?? []).flatMap(approvedConnectorToolRefs));
  const contractForRef = (ref: string) => {
    const discovered = definition.builderMeta?.discoveredToolContracts?.find((raw) =>
      typeof raw.toolRef === "string" && raw.toolRef.toLowerCase() === ref.toLowerCase());
    if (discovered) return discovered as unknown as ReturnType<typeof getStaticToolContract>;
    return getStaticToolContract(ref);
  };
  for (const agent of definition.agentGraph?.children ?? []) {
    if (!agent.nodeKind || !agent.outputContract?.mediaType || !agent.outputContract.visibility) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Workflow node ${agent.id} requires explicit contracts.`,
      });
    }
    const agentToolContracts = agent.tools.map((tool) => ({ tool, contract: contractForRef(tool.ref) }));
    for (const tool of agent.tools) {
      if (tool.ref === "canvas.email") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "canvas.email is a render target, not an agent tool",
        });
      }
      const normalizedRef = tool.ref.toLowerCase();
      const contract = contractForRef(tool.ref);
      const isApprovedWrite = approvedWriteRefs.has(normalizedRef);
      const isApprovedRead = approvedReadRefs.has(normalizedRef);
      if (/^composio\.[a-z0-9_-]+\.action\./.test(normalizedRef) && !isApprovedWrite && !isApprovedRead) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Connector action ${tool.ref} is not approved by this workflow's connector policy`,
        });
      }
      const requiredContractInputs = Array.isArray(contract?.inputSchema.required)
        ? contract.inputSchema.required
        : [];
      if (/^composio\.[a-z0-9_-]+\.action\./.test(normalizedRef)
        && requiredContractInputs.length > 0
        && agent.handoffBindings.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Connector action ${tool.ref} must consume provenance-checked field bindings`,
        });
      }
      if (/^composio\.[a-z0-9_-]+\.action\./.test(normalizedRef)) {
        for (const binding of agent.handoffBindings) {
          if (!binding.provenance || !binding.valuePolicy) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Connector action ${tool.ref} binding ${binding.targetPath} lacks provenance metadata`,
            });
          }
          if (binding.valuePolicy === "passthrough" && binding.provenance === "agent_output") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Connector action ${tool.ref} passthrough binding ${binding.targetPath} cannot come from a semantic agent`,
            });
          }
        }
      }
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
    if (hasApprovedWrite && !definition.operatorInteractionPlan.interactions.some((item) =>
      item.kind === "confirm_action" && item.actionNodeId === agent.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External-effect tools require a typed confirmation interaction" });
    }
  }
});

export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type RuntimeAgent = z.infer<typeof loopRunAgentSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;

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

export const runtimeContextSchema = z.object({
  inputs: z.record(z.string()).default({}),
  approvedMemories: z.array(z.object({ id: z.string(), excerpt: z.string() })).default([]),
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
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outbound delivery is disabled in the stable runtime" });
  }
  for (const agent of definition.agentGraph?.children ?? []) {
    for (const tool of agent.tools) {
      if (
        tool.ref === "internal.resend_broadcast"
        || tool.ref === "composio.gmail.send_email"
        || tool.ref === "internal.email_approval_request"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Outbound tool ${tool.ref} is disabled in the stable runtime`,
        });
      }
    }
    if (agent.gate?.type === "pre_send") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pre_send gates require outbound delivery and are disabled" });
    }
  }
});

export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type RuntimeAgent = z.infer<typeof loopRunAgentSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;

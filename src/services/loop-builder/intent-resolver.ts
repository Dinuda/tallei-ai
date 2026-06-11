import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { createLoopWorkflow } from "../loop-executor/creator.js";
import { loopDefinitionSchema, loopStageApprovalChannelInputSchema } from "../loop-executor/types.js";
import { noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import { channelsFromDesign, designLoopFromIntent, loopBuilderTraceSchema } from "../loop-engine/architect.js";
import { approvedSpecSnapshot, getLoopSpec } from "./specs.js";

/** Optional UI hint passed to the LLM — does not bypass the builder. */
export const builderTemplateHintSchema = z.enum([
  "custom",
]);
export type LoopBuilderTemplateHint = z.infer<typeof builderTemplateHintSchema>;

export const loopBuilderProposalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  templateId: builderTemplateHintSchema.default("custom"),
  definition: loopDefinitionSchema,
  suggestedChannels: z.array(loopStageApprovalChannelInputSchema).default(["primary"]),
  suggestedToolRefs: z.array(z.string().min(1)).default([]),
  memories: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  preferences: z.array(z.object({
    id: z.string(),
    text: z.string(),
    category: z.string().nullable().optional(),
  })).default([]),
  rationale: z.array(z.string().min(1)).default([]),
  designedBy: z.enum(["ceo_llm", "loop_architect"]).default("loop_architect"),
  model: z.string().optional(),
  noSlopSpec: noSlopSpecSnapshotSchema.optional(),
  trace: loopBuilderTraceSchema.optional(),
});

export type LoopBuilderProposal = z.infer<typeof loopBuilderProposalSchema>;

type BuilderContext = {
  auth: AuthContext;
  prompt: string;
  templateId?: LoopBuilderTemplateHint;
  feedback?: string;
  specId?: string;
  priorProposal?: LoopBuilderProposal;
};

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function templateHintFromRequest(templateId?: LoopBuilderTemplateHint): string | undefined {
  void templateId;
  return undefined;
}

export async function resolveLoopBuilderIntent(input: BuilderContext): Promise<LoopBuilderProposal> {
  const prompt = normalizePrompt(input.prompt);
  if (!prompt) throw new Error("Prompt is required");
  const noSlopSpec = input.specId
    ? approvedSpecSnapshot(
        await getLoopSpec(input.auth, input.specId)
          .then((spec) => {
            if (!spec) throw new Error("Loop spec not found");
            return spec;
          }),
      )
    : undefined;

  const result = await designLoopFromIntent({
    auth: input.auth,
    prompt: input.feedback
      ? [prompt, `Template hint: ${templateHintFromRequest(input.templateId) ?? "custom"}`].filter(Boolean).join("\n\n")
      : prompt,
    feedback: input.feedback,
    noSlopSpec,
    priorProposal: input.priorProposal,
  });

  const templateId = input.templateId ?? "custom";
  const channels = channelsFromDesign(result.suggestedChannels);

  return loopBuilderProposalSchema.parse({
    title: result.design.title,
    summary: result.design.summary,
    templateId,
    definition: result.definition,
    suggestedChannels: channels,
    suggestedToolRefs: result.suggestedToolRefs,
    memories: result.memories.map(({ id, text }) => ({ id, text })),
    preferences: result.preferences,
    rationale: result.design.rationale,
    designedBy: "loop_architect",
    model: result.model,
    ...(noSlopSpec ? { noSlopSpec } : {}),
    trace: result.trace,
  });
}

export async function refineLoopBuilderProposal(input: BuilderContext & { priorProposal: LoopBuilderProposal }): Promise<LoopBuilderProposal> {
  const prompt = normalizePrompt(input.prompt);
  return resolveLoopBuilderIntent({
    auth: input.auth,
    prompt,
    templateId: input.templateId,
    feedback: input.feedback ?? prompt,
    specId: input.specId ?? input.priorProposal.noSlopSpec?.id,
    priorProposal: input.priorProposal,
  });
}

export async function saveLoopBuilderProposal(input: {
  auth: AuthContext;
  proposal: unknown;
  cron?: string;
  timezone?: string;
  workspaceId?: string | null;
}) {
  const proposal = loopBuilderProposalSchema.parse(input.proposal);
  const definition = proposal.definition;
  const schedule = {
    cron: input.cron ?? definition.schedule.cron,
    timezone: input.timezone ?? definition.schedule.timezone,
  };
  return createLoopWorkflow({
    auth: input.auth,
    definition: {
      ...definition,
      schedule,
    },
    title: proposal.title,
    workspaceId: input.workspaceId ?? null,
  });
}

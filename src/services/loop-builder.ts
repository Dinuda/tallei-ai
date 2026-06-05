import { z } from "zod";

import type { AuthContext } from "../domain/auth/index.js";
import { listPreferences, recallMemories } from "./memory.js";
import { buildLoopDefinition, createLoopWorkflow } from "./loop-executor/creator.js";
import { listLoopTools } from "./loop-executor/tool-catalog.js";
import type { LoopDefinition, LoopPlan, LoopStageApprovalChannel } from "./loop-executor/types.js";

const builderTemplateSchema = z.enum(["blog_post", "weekly_report", "social_content", "custom"]);
export type LoopBuilderTemplateId = z.infer<typeof builderTemplateSchema>;

const builderProposalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  templateId: builderTemplateSchema,
  definition: z.custom<LoopDefinition>(),
  suggestedChannels: z.array(z.enum(["primary", "email", "gmail", "telegram", "whatsapp"])).default(["primary"]),
  suggestedToolRefs: z.array(z.string().min(1)).default([]),
  memories: z.array(z.object({
    id: z.string(),
    text: z.string(),
  })).default([]),
  preferences: z.array(z.object({
    id: z.string(),
    text: z.string(),
    category: z.string().nullable().optional(),
  })).default([]),
  rationale: z.array(z.string().min(1)).default([]),
});

export type LoopBuilderProposal = z.infer<typeof builderProposalSchema>;

type BuilderContext = {
  auth: AuthContext;
  prompt: string;
  templateId?: LoopBuilderTemplateId;
  feedback?: string;
};

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function inferTemplateId(prompt: string, requested?: LoopBuilderTemplateId): LoopBuilderTemplateId {
  if (requested && requested !== "custom") return requested;
  const text = prompt.toLowerCase();
  if (/\b(tweet|thread|linkedin|social|post to x|post on x|social content)\b/.test(text)) return "social_content";
  if (/\bweekly report|weekly update|ops review|status report|digest\b/.test(text)) return "weekly_report";
  if (/\bblog|article|post\b/.test(text)) return "blog_post";
  return requested ?? "custom";
}

function inferChannels(prompt: string): LoopStageApprovalChannel[] {
  const text = prompt.toLowerCase();
  if (/\btelegram\b/.test(text)) return ["telegram"];
  if (/\bwhatsapp\b/.test(text)) return ["whatsapp"];
  if (/\bgmail\b/.test(text)) return ["gmail"];
  if (/\bemail\b/.test(text)) return ["email"];
  return ["primary"];
}

function slug(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return normalized || fallback;
}

function chooseTitle(prompt: string, templateId: LoopBuilderTemplateId): string {
  const base = normalizePrompt(prompt);
  if (base.length <= 72) return base;
  if (templateId === "blog_post") return "Recurring blog post loop";
  if (templateId === "weekly_report") return "Weekly report loop";
  if (templateId === "social_content") return "Social content loop";
  return "Custom loop";
}

function chooseSummary(templateId: LoopBuilderTemplateId, prompt: string): string {
  if (templateId === "blog_post") return "Researches, drafts, and sends a blog post through an approval gate.";
  if (templateId === "weekly_report") return "Compiles context from memory, writes a report, and pauses for approval before delivery.";
  if (templateId === "social_content") return "Generates social-ready content drafts grounded in memory and current context before approval.";
  return `Builds a reusable loop from: ${normalizePrompt(prompt)}`;
}

function buildArtifacts(templateId: LoopBuilderTemplateId) {
  if (templateId === "social_content") {
    return [
      { id: "brief", kind: "research_notes", label: "Content brief" },
      { id: "draft", kind: "content", label: "Social draft" },
    ];
  }
  if (templateId === "weekly_report") {
    return [
      { id: "brief", kind: "research_notes", label: "Report brief" },
      { id: "draft", kind: "document", label: "Weekly report draft" },
    ];
  }
  return [
    { id: "brief", kind: "research_notes", label: "Brief" },
    { id: "draft", kind: "content", label: "Draft" },
  ];
}

function buildPlan(input: {
  templateId: LoopBuilderTemplateId;
  prompt: string;
  channels: LoopStageApprovalChannel[];
}): LoopPlan {
  const stages = [
    {
      kind: "agent" as const,
      id: "memory_brief",
      name: "Memory Brief",
      task: `Search memory for prior work, tone, format, and operating preferences relevant to: ${input.prompt}`,
      toolRef: "internal.memory_search",
      outputArtifactId: "brief",
    },
    input.templateId === "weekly_report" || input.templateId === "social_content"
      ? {
          kind: "agent" as const,
          id: "web_context",
          name: "Live Context",
          task: `Gather live context, recent references, and timely inputs that improve this loop output: ${input.prompt}`,
          toolRef: "internal.web_search",
          outputArtifactId: "brief",
        }
      : null,
    {
      kind: "agent" as const,
      id: "writer",
      name: input.templateId === "social_content" ? "Content Writer" : "Writer",
      task: input.templateId === "social_content"
        ? `Write a set of social-ready posts with hooks, body copy, and CTA based on the brief for: ${input.prompt}`
        : `Write the final output using the approved structure, tone, and evidence for: ${input.prompt}`,
      toolRef: null,
      outputArtifactId: "draft",
    },
    {
      kind: "approval_gate" as const,
      id: "approval",
      label: "Review output before delivery",
      artifactId: "draft",
      required: true as const,
      approvalPolicy: {
        required: true,
        mode: "manual_gate" as const,
        channels: input.channels,
        onReject: "block" as const,
      },
    },
  ].filter(Boolean);

  return {
    goal: input.prompt,
    stages,
    artifacts: buildArtifacts(input.templateId),
    allowedToolRefs: [...new Set(stages.flatMap((stage) => {
      if (!stage) return [];
      if (stage.kind === "agent" && stage.toolRef) return [stage.toolRef];
      return [];
    }))],
    allowedIntegrations: ["internal"],
  };
}

function chooseSuggestedTools(plan: LoopPlan): string[] {
  const known = new Set(listLoopTools().map((tool) => tool.ref));
  return [...new Set(plan.allowedToolRefs.filter((ref) => known.has(ref)))];
}

function buildRationale(input: {
  templateId: LoopBuilderTemplateId;
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
}): string[] {
  const lines = [
    `Using the ${input.templateId.replace(/_/g, " ")} template keeps the first version generic and executable with the current tool catalog.`,
  ];
  if (input.memories[0]) {
    lines.push(`Memory context is included so the writer can inherit prior tone, format, and domain context.`);
  }
  if (input.preferences[0]) {
    lines.push(`Saved preferences are available to bias approval channels, structure, and output style.`);
  }
  lines.push("The plan stops at an approval gate so the builder does not assume a delivery connector that may not exist.");
  return lines;
}

export async function resolveLoopBuilderIntent(input: BuilderContext): Promise<LoopBuilderProposal> {
  const prompt = normalizePrompt([input.prompt, input.feedback].filter(Boolean).join("\n"));
  const templateId = inferTemplateId(prompt, input.templateId);
  const [memoryResult, preferences] = await Promise.all([
    recallMemories(prompt, input.auth, 6).catch(() => ({ memories: [] })),
    listPreferences(input.auth).catch(() => []),
  ]);
  const channels = inferChannels(prompt);
  const plan = buildPlan({ templateId, prompt, channels });
  const definition = buildLoopDefinition({
    task: prompt,
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: plan.allowedIntegrations,
    allowedToolRefs: plan.allowedToolRefs,
    plan,
    deliveryType: templateId === "blog_post" ? "plain" : undefined,
  });
  return builderProposalSchema.parse({
    title: chooseTitle(prompt, templateId),
    summary: chooseSummary(templateId, prompt),
    templateId,
    definition,
    suggestedChannels: channels,
    suggestedToolRefs: chooseSuggestedTools(plan),
    memories: (memoryResult.memories ?? []).map((memory) => ({ id: memory.id, text: memory.text })),
    preferences: preferences.slice(0, 8).map((preference) => ({
      id: preference.id,
      text: preference.text,
      category: preference.category ?? null,
    })),
    rationale: buildRationale({
      templateId,
      memories: (memoryResult.memories ?? []).map((memory) => ({ id: memory.id, text: memory.text })),
      preferences: preferences.slice(0, 8).map((preference) => ({
        id: preference.id,
        text: preference.text,
        category: preference.category ?? null,
      })),
    }),
  });
}

export async function refineLoopBuilderProposal(input: BuilderContext): Promise<LoopBuilderProposal> {
  return resolveLoopBuilderIntent(input);
}

export async function saveLoopBuilderProposal(input: {
  auth: AuthContext;
  proposal: LoopBuilderProposal;
  cron?: string;
  timezone?: string;
  workspaceId?: string | null;
}) {
  const definition = input.proposal.definition;
  return createLoopWorkflow({
    auth: input.auth,
    task: definition.goal,
    cron: input.cron ?? definition.schedule.cron,
    timezone: input.timezone ?? definition.schedule.timezone,
    integrations: definition.allowedIntegrations,
    allowedToolRefs: definition.allowedToolRefs,
    agentGraph: definition.agentGraph,
    plan: definition.plan,
    schedulerTarget: definition.schedulerTarget,
    workspaceId: input.workspaceId ?? null,
    presetId: definition.presetId,
    deliveryType: definition.deliveryType,
  });
}

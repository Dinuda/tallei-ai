import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences, recallMemories } from "../memory.js";
import { buildLoopDefinition, createLoopWorkflow } from "../loop-executor/creator.js";
import { listLoopTools } from "../loop-executor/tool-catalog.js";
import {
  loopDefinitionSchema,
  type LoopDefinition,
  type LoopPlan,
  type LoopStageApprovalChannel,
} from "../loop-executor/types.js";

export const builderTemplateSchema = z.enum(["blog_post", "weekly_report", "social_content", "custom"]);
export type LoopBuilderTemplateId = z.infer<typeof builderTemplateSchema>;

/** Detects newsletter/broadcast intent from the user's prompt. */
function isNewsletterIntent(prompt: string): boolean {
  return /\b(newsletter|broadcast|lenny|lenny'?s|email blast|weekly issue|subscribers?|subscriber.facing)\b/i.test(prompt);
}

export const loopBuilderProposalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  templateId: builderTemplateSchema,
  definition: loopDefinitionSchema,
  suggestedChannels: z.array(z.enum(["primary", "email", "gmail", "telegram", "whatsapp"])).default(["primary"]),
  suggestedToolRefs: z.array(z.string().min(1)).default([]),
  memories: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  preferences: z.array(z.object({
    id: z.string(),
    text: z.string(),
    category: z.string().nullable().optional(),
  })).default([]),
  rationale: z.array(z.string().min(1)).default([]),
});

export type LoopBuilderProposal = z.infer<typeof loopBuilderProposalSchema>;

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

function chooseTitle(prompt: string, templateId: LoopBuilderTemplateId): string {
  const base = normalizePrompt(prompt);
  if (base.length <= 72) return base;
  if (templateId === "blog_post") return "Recurring blog post loop";
  if (templateId === "weekly_report") return "Weekly report loop";
  if (templateId === "social_content") return "Social content loop";
  return "Custom loop";
}

function chooseSummary(templateId: LoopBuilderTemplateId, prompt: string): string {
  if (templateId === "blog_post") return "Researches, drafts, and pauses for approval before publication work.";
  if (templateId === "weekly_report") return "Compiles memory and live context into an approval-ready weekly report.";
  if (templateId === "social_content") return "Creates social-ready content drafts grounded in memory and timely context.";
  return `Builds a reusable loop from: ${normalizePrompt(prompt)}`;
}

function buildArtifacts(templateId: LoopBuilderTemplateId): LoopPlan["artifacts"] {
  if (templateId === "weekly_report") {
    return [
      { id: "brief", kind: "research_notes", label: "Report brief" },
      { id: "draft", kind: "document", label: "Weekly report draft" },
    ];
  }
  if (templateId === "social_content") {
    return [
      { id: "brief", kind: "research_notes", label: "Content brief" },
      { id: "draft", kind: "content", label: "Social content draft" },
    ];
  }
  return [
    { id: "brief", kind: "research_notes", label: "Brief" },
    { id: "draft", kind: "content", label: "Draft" },
  ];
}

function buildNewsletterPlan(input: {
  prompt: string;
  channels: LoopStageApprovalChannel[];
}): LoopPlan {
  const stages: LoopPlan["stages"] = [
    {
      kind: "agent",
      id: "memory_search",
      name: "Memory Search",
      task: [
        "Search memory for previous newsletters, writing voice, tone, formatting style, recurring sections, and editorial preferences.",
        "Fetch prior issue examples and any saved preferences about content structure or sign-offs.",
        "Output: (1) a ranked list of 3 topic candidates grounded in memory and recent user patterns,",
        "(2) a clear voice/style summary covering tone, section structure, heading style, sign-off format, and any hard rules.",
        `Goal: ${input.prompt}`,
      ].join(" "),
      toolRef: "internal.memory_search",
      outputArtifactId: "brief",
    },
    {
      kind: "agent",
      id: "source_research",
      name: "Source Research",
      task: [
        "Gather this week's most relevant source material for the newsletter topic candidates.",
        "Identify the strongest lead-topic candidate, note supporting source URLs, and surface what is most timely and relevant to readers.",
        "Do not select a topic yet — produce concise source notes for the Research Agent.",
        `Goal: ${input.prompt}`,
      ].join(" "),
      toolRef: "internal.web_search",
      outputArtifactId: "brief",
    },
    {
      kind: "agent",
      id: "research_brief",
      name: "Research Brief",
      task: [
        "Synthesize the Memory Search and Source Research outputs into a concise writer briefing.",
        "Select one lead topic. Explain why it best fits the audience and the user's editorial direction. State why the other candidates were not selected.",
        "Pass the voice/style summary from memory to the Writer verbatim.",
        "Output: selected topic, why now, core arguments, source links to cite, and tone/structure guidance.",
        `Goal: ${input.prompt}`,
      ].join(" "),
      toolRef: null,
      outputArtifactId: "brief",
    },
    {
      kind: "agent",
      id: "writer",
      name: "Writer",
      task: [
        "Write the subscriber-facing newsletter draft using the Research Brief.",
        "FIRST: Review the voice/style summary. Adopt that exact tone, section structure, heading style, and sign-off format.",
        "If previous newsletters exist in memory, match their voice precisely — do not invent a new style.",
        "Line 1 must be exactly: Subject: <email subject>. From line 2 onward: final subscriber-ready sections only.",
        "Do not include draft labels, approval instructions, or internal handoff notes.",
        `Goal: ${input.prompt}`,
      ].join(" "),
      toolRef: null,
      outputArtifactId: "draft",
    },
    {
      kind: "approval_gate",
      id: "approval",
      label: "Review draft before delivery",
      artifactId: "draft",
      required: true,
      approvalPolicy: {
        required: true,
        mode: "manual_gate",
        channels: input.channels,
        onReject: "block",
      },
    },
  ];

  return {
    goal: input.prompt,
    stages,
    artifacts: [
      { id: "brief", kind: "research_notes", label: "Research brief" },
      { id: "draft", kind: "content", label: "Newsletter draft" },
    ],
    allowedToolRefs: ["internal.memory_search", "internal.web_search", "internal.llm_only"],
    allowedIntegrations: ["internal"],
  };
}

function buildPlan(input: {
  templateId: LoopBuilderTemplateId;
  prompt: string;
  channels: LoopStageApprovalChannel[];
}): LoopPlan {
  const stages: LoopPlan["stages"] = [
    {
      kind: "agent",
      id: "memory_brief",
      name: "Memory Brief",
      task: `Search memory for prior work, tone, format, and operating preferences relevant to: ${input.prompt}`,
      toolRef: "internal.memory_search",
      outputArtifactId: "brief",
    },
  ];

  if (input.templateId === "weekly_report" || input.templateId === "social_content") {
    stages.push({
      kind: "agent",
      id: "web_context",
      name: "Live Context",
      task: `Gather current context and timely references that improve this loop output: ${input.prompt}`,
      toolRef: "internal.web_search",
      outputArtifactId: "brief",
    });
  }

  stages.push({
    kind: "agent",
    id: "writer",
    name: input.templateId === "social_content" ? "Content Writer" : "Writer",
    task: input.templateId === "social_content"
      ? `Write social-ready options with hooks, body copy, and CTA based on the brief for: ${input.prompt}`
      : `Write the final output using the brief, saved preferences, and relevant evidence for: ${input.prompt}`,
    toolRef: null,
    outputArtifactId: "draft",
  });

  stages.push({
    kind: "approval_gate",
    id: "approval",
    label: "Review output before delivery",
    artifactId: "draft",
    required: true,
    approvalPolicy: {
      required: true,
      mode: "manual_gate",
      channels: input.channels,
      onReject: "block",
    },
  });

  return {
    goal: input.prompt,
    stages,
    artifacts: buildArtifacts(input.templateId),
    allowedToolRefs: [...new Set(stages.flatMap((stage) => {
      if (stage.kind === "agent" && stage.toolRef) return [stage.toolRef];
      if (stage.kind === "external_action") return [stage.toolRef];
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
  isNewsletter: boolean;
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
}): string[] {
  if (input.isNewsletter) {
    const lines = ["Newsletter preset selected: runs a 5-stage pipeline (memory search → source research → brief → writer → approval)."];
    if (input.memories.length > 0) lines.push("Memory is searched for previous issues, voice, tone, and formatting to ensure the writer matches your exact style.");
    if (input.preferences.length > 0) lines.push("Saved preferences are applied to output style, approval routing, and delivery behavior.");
    lines.push("The Writer receives a full briefing including topic selection, source citations, and voice/style guidance before writing.");
    lines.push("Draft stops at approval before any delivery action is taken.");
    return lines;
  }
  const lines = [`Selected ${input.templateId.replace(/_/g, " ")} as the closest executable template.`];
  if (input.memories.length > 0) lines.push("Relevant memory is included for voice, context, and repeated user patterns.");
  if (input.preferences.length > 0) lines.push("Saved preferences are included for output style and approval behavior.");
  lines.push("The generated plan stops at approval unless a registered external-action handler is selected.");
  return lines;
}

/** Newsletter memory query focuses on voice, prior issues, and editorial style. */
function buildNewsletterMemoryQuery(prompt: string): string {
  return [
    prompt,
    "newsletter previous issues writing style voice tone formatting sections sign-off editorial preferences",
    "Lenny newsletter product builders style weekly",
  ].join(" ");
}

export async function resolveLoopBuilderIntent(input: BuilderContext): Promise<LoopBuilderProposal> {
  const prompt = normalizePrompt([input.prompt, input.feedback].filter(Boolean).join("\n"));
  const templateId = inferTemplateId(prompt, input.templateId);
  const newsletter = isNewsletterIntent(prompt);

  const memoryQuery = newsletter ? buildNewsletterMemoryQuery(prompt) : prompt;
  const memoryLimit = newsletter ? 15 : 6;

  const [memoryResult, preferences] = await Promise.all([
    recallMemories(memoryQuery, input.auth, memoryLimit).catch(() => ({ memories: [] })),
    listPreferences(input.auth).catch(() => []),
  ]);
  const memories = (memoryResult.memories ?? []).map((memory) => ({ id: memory.id, text: memory.text }));
  const selectedPreferences = preferences.slice(0, 8).map((preference) => ({
    id: preference.id,
    text: preference.text,
    category: preference.category ?? null,
  }));
  const channels = inferChannels(prompt);

  if (newsletter) {
    const plan = buildNewsletterPlan({ prompt, channels });
    const definition: LoopDefinition = buildLoopDefinition({
      task: prompt,
      cron: "0 9 * * 5",
      timezone: "UTC",
      integrations: plan.allowedIntegrations,
      allowedToolRefs: plan.allowedToolRefs,
      plan,
      presetId: "newsletter",
      deliveryType: "newsletter",
    });

    return loopBuilderProposalSchema.parse({
      title: chooseTitle(prompt, templateId),
      summary: "Runs a full newsletter pipeline: memory search → source research → topic brief → writer (voice-matched) → approval before delivery.",
      templateId,
      definition,
      suggestedChannels: channels,
      suggestedToolRefs: chooseSuggestedTools(plan),
      memories,
      preferences: selectedPreferences,
      rationale: buildRationale({ templateId, isNewsletter: true, memories, preferences: selectedPreferences }),
    });
  }

  const plan = buildPlan({ templateId, prompt, channels });
  const definition: LoopDefinition = buildLoopDefinition({
    task: prompt,
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: plan.allowedIntegrations,
    allowedToolRefs: plan.allowedToolRefs,
    plan,
    deliveryType: templateId === "blog_post" ? "plain" : undefined,
  });

  return loopBuilderProposalSchema.parse({
    title: chooseTitle(prompt, templateId),
    summary: chooseSummary(templateId, prompt),
    templateId,
    definition,
    suggestedChannels: channels,
    suggestedToolRefs: chooseSuggestedTools(plan),
    memories,
    preferences: selectedPreferences,
    rationale: buildRationale({ templateId, isNewsletter: false, memories, preferences: selectedPreferences }),
  });
}

export async function refineLoopBuilderProposal(input: BuilderContext): Promise<LoopBuilderProposal> {
  return resolveLoopBuilderIntent(input);
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

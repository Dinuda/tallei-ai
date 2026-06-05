import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences, recallMemories } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import {
  isNewsletterDeliveryDefinition,
  normalizeGraphResponsibilities,
} from "../loop-executor/agent-responsibilities.js";
import { formatTemplateCatalogForPrompt, getLoopTemplate } from "../loop-executor/templates/registry.js";
import { getEffectiveLoopConstraints, listLoopTools, validateAgentRoster } from "../loop-executor/tool-catalog.js";
import {
  loopAgentGraphSchema,
  loopStageApprovalChannelInputSchema,
  optionalNonEmptyStringSchema,
  type LoopAgentGraph,
  type LoopDefinition,
  type LoopStageApprovalChannel,
} from "../loop-executor/types.js";
import { loopBuilderOpenAiChat, loopBuilderOpenAiModel } from "./openai-chat.js";

export type DesignerTestOverrides = {
  chat?: typeof loopBuilderOpenAiChat;
  recallMemories?: typeof recallMemories;
  listPreferences?: typeof listPreferences;
};

const ceoDesignOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  strategyText: z.string().min(1),
  agentGraph: loopAgentGraphSchema,
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1).default("UTC"),
  }),
  deliveryType: optionalNonEmptyStringSchema,
  presetId: optionalNonEmptyStringSchema,
  builderMeta: z.object({
    designedBy: z.literal("ceo_llm").default("ceo_llm"),
    preApproved: z.boolean().default(true),
    // sourceTemplateIds intentionally omitted from LLM schema — we don't want model labelling patterns
  }),
  rationale: z.array(z.string().min(1)).default([]),
  suggestedChannels: z.array(loopStageApprovalChannelInputSchema).default(["primary"]),
});

export type CeoDesignOutput = z.infer<typeof ceoDesignOutputSchema>;

const loopDeliveryClassificationSchema = z.object({
  deliveryType: z.enum(["newsletter", "plain", "none"]).default("none"),
  deliveryTarget: z.enum(["subscriber_list", "operator", "none"]).default("none"),
  approvalChannels: z.array(loopStageApprovalChannelInputSchema).default(["primary"]),
  cadenceGuess: z.string().min(1),
  externalActionRequired: z.boolean(),
  subscriberBroadcastRequired: z.boolean(),
  explicitLegacyPresetRequested: z.boolean().default(false),
});

export type LoopDeliveryClassification = z.infer<typeof loopDeliveryClassificationSchema>;

const workflowCriticResultSchema = z.object({
  pass: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high"]),
  issues: z.array(z.string()).default([]),
  requiredFixes: z.array(z.string()).default([]),
  optionalImprovements: z.array(z.string()).default([]),
});

export type WorkflowCriticResult = z.infer<typeof workflowCriticResultSchema>;

const loopBuilderTraceStageSchema = z.object({
  stage: z.string().min(1),
  model: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
});

export type LoopBuilderTraceStage = z.infer<typeof loopBuilderTraceStageSchema>;

export const loopBuilderTraceSchema = z.object({
  stages: z.array(loopBuilderTraceStageSchema).default([]),
});

export type LoopBuilderTrace = z.infer<typeof loopBuilderTraceSchema>;

export type FinalizedLoopDesign = CeoDesignOutput & {
  designDiagnostics?: {
    deliveryClassification: LoopDeliveryClassification;
    critic: WorkflowCriticResult;
    trace?: LoopBuilderTrace;
  };
  trace?: LoopBuilderTrace;
};

export type DesignLoopInput = {
  auth: AuthContext;
  prompt: string;
  feedback?: string;
  templateHint?: string;
  priorProposal?: {
    title: string;
    summary: string;
    definition: { agentGraph?: LoopAgentGraph };
    rationale: string[];
  };
  testOverrides?: DesignerTestOverrides;
};

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildMemoryQuery(prompt: string): string {
  return [
    prompt,
    "writing style voice tone formatting audience editorial preferences prior work",
    "recurring content sections sign-off",
  ].join(" ");
}

function formatMemoriesForPrompt(memories: Array<{ id: string; text: string }>): string {
  if (memories.length === 0) return "No relevant memories found.";
  return memories.map((memory, index) => `${index + 1}. [${memory.id}] ${memory.text}`).join("\n");
}

function formatPreferencesForPrompt(
  preferences: Array<{ id: string; text: string; category?: string | null }>,
): string {
  if (preferences.length === 0) return "No saved preferences.";
  return preferences.map((pref, index) => {
    const category = pref.category ? ` (${pref.category})` : "";
    return `${index + 1}. [${pref.id}]${category} ${pref.text}`;
  }).join("\n");
}

function formatToolCatalogForPrompt(): string {
  return listLoopTools()
    .map((tool) => `- ${tool.ref}: ${tool.description}${tool.requiresConnector ? " (requires connector)" : ""}`)
    .join("\n");
}

function collectSuggestedToolRefs(agentGraph: LoopAgentGraph): string[] {
  const known = new Set(listLoopTools().map((tool) => tool.ref));
  const refs = agentGraph.children.flatMap((child) => child.tools.map((tool) => tool.ref));
  return [...new Set(refs.filter((ref) => known.has(ref)))];
}

function summarizeAgentGraph(agentGraph: LoopAgentGraph) {
  return {
    parent: {
      id: agentGraph.parent.id,
      name: agentGraph.parent.name,
    },
    children: agentGraph.children.map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      tools: child.tools.map((tool) => tool.ref),
    })),
  };
}

function classifyDeliveryIntent(input: {
  prompt: string;
  feedback?: string;
  templateHint?: string;
}): LoopDeliveryClassification {
  const text = `${input.prompt} ${input.feedback ?? ""} ${input.templateHint ?? ""}`.toLowerCase();
  const subscriberBroadcastRequired = /\b(subscribers?|subscriber list|mailing list|email list|audience|broadcast|send them|send to readers|send to customers)\b/i.test(text);
  const deliveryType = subscriberBroadcastRequired
    ? "newsletter"
    : /\b(send to me|for my review|personal digest|internal report)\b/i.test(text)
      ? "plain"
      : "none";
  const cadenceGuess = /\bmonthly\b/i.test(text)
    ? "0 9 1 * *"
    : /\bdaily\b/i.test(text)
      ? "0 9 * * *"
      : /\bfriday\b/i.test(text)
        ? "0 9 * * 5"
        : "0 9 * * 1";

  return loopDeliveryClassificationSchema.parse({
    deliveryType,
    deliveryTarget: subscriberBroadcastRequired ? "subscriber_list" : deliveryType === "plain" ? "operator" : "none",
    approvalChannels: ["primary"],
    cadenceGuess,
    externalActionRequired: subscriberBroadcastRequired,
    subscriberBroadcastRequired,
    explicitLegacyPresetRequested: false,
  });
}

function curateEvidence(input: {
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
}) {
  return {
    memories: input.memories,
    preferences: input.preferences,
    memoryBlock: formatMemoriesForPrompt(input.memories),
    preferenceBlock: formatPreferencesForPrompt(input.preferences),
    templateCatalog: formatTemplateCatalogForPrompt(),
    toolCatalog: formatToolCatalogForPrompt(),
  };
}

function buildSystemPrompt(classification: LoopDeliveryClassification): string {
  const outputShape = JSON.stringify({
    title: "Short descriptive loop title",
    summary: "One sentence: what this loop produces and how it delivers",
    strategyText: "Explain the roster and why each agent is needed for this user's outcome",
    agentGraph: {
      parent: {
        id: "parent_agent",
        name: "Parent Agent",
        task: "Coordinate the loop end-to-end for [user's goal]",
        policy: "Route work to specialists; approve before delivering; ground in memory",
      },
      children: [
        {
          id: "snake_case_id",
          name: "Descriptive agent name",
          task: "Concrete, executable task grounded in the user's memory and intent",
          tools: [{ ref: "internal.memory_search" }],
        },
      ],
    },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    deliveryType: "newsletter OR plain OR omit",
    presetId: "always omit",
    builderMeta: { designedBy: "ceo_llm", preApproved: true },
    rationale: ["Concrete reason this roster serves the user's stated outcome"],
    suggestedChannels: ["primary"],
  });

  return [
    "You are a loop architect for Tallei. Design original, bespoke recurring agent loops from the user's intent.",
    "Think from first principles. Do NOT copy any reference pattern verbatim.",
    "Never mention pattern names, template IDs, or preset labels in your output.",
    "",
    "=== STEP 1: PARSE THE END OUTCOME ===",
    "Before designing, determine:",
    "- What is the primary deliverable? (written piece, report, post, digest, data summary…)",
    "- Who receives the final output, and how? (just the user, a subscriber list, a social platform, an external system?)",
    "- What approval step is needed before delivery?",
    "- What cadence fits?",
    "",
    "=== STEP 2: DELIVERY INTENT DETECTION ===",
    "Use this delivery classification. Do not reclassify it:",
    JSON.stringify(classification),
    "",
    "→ BROADCAST TO SUBSCRIBERS / AUDIENCE / MAILING LIST:",
    "  Triggers: 'subscribers', 'mailing list', 'email list', 'send to audience', 'broadcast', 'distribute to readers'",
    "  Action: set deliveryType: 'newsletter' and omit presetId.",
    "  Do not use a fixed newsletter preset/template. Templates/patterns are inspiration only.",
    "  This activates: approval → recipient upload → email broadcast as the delivery mechanism, while the CEO still designs the bespoke agent roster.",
    "  Spawn three separate post-writer agents in this order: Email Build Agent (internal.email_builder_compose, internal.email_builder_render), Approval Agent (internal.email_approval_request only), Broadcast Delivery Agent (internal.resend_broadcast only).",
    "  Keep responsibilities separate: writer writes only; Email Build Agent composes/renders only; Approval Agent sends the approval request only; Broadcast Delivery Agent syncs recipients and submits Resend only after approval + recipient upload.",
    "",
    "→ POST TO SOCIAL / PUBLISH ONLINE:",
    "  Triggers: Twitter/X, LinkedIn, Instagram, blog post, publish",
    "  Action: use composio connector tools; approval agent before posting",
    "",
    "→ SEND TO ME / REPORT / PERSONAL DIGEST:",
    "  Triggers: 'send to me', 'for my review', 'personal update', 'internal report'",
    "  Action: approval agent with internal.email_approval_request only; deliveryType: 'plain'",
    "",
    "→ PRODUCE AND APPROVE ONLY (no external delivery):",
    "  Triggers: 'draft', 'create', 'write' with no delivery target",
    "  Action: approval agent only, omit presetId and deliveryType",
    "",
    "=== STEP 3: DESIGN THE MINIMAL ROSTER ===",
    "Spawn 2–6 specialist child agents. Adapt this general execution flow to the user's specific need:",
    "1. Research (search memory for voice/style/past work, then gather live sources if content requires it)",
    "2. Synthesize (turn research into a concrete brief for the producer)",
    "3. Produce (write, compose, generate — grounded in the brief and memory voice)",
    "4. Email build (compose/render only — no approval request, no broadcast)",
    "5. Approval (approval request only — no email build, no broadcast)",
    "6. Deliver (only if Step 2 identified a delivery target — broadcast/sync only, no writing or approval work)",
    "",
    "Hard boundary rule:",
    "- Every child agent must do exactly one thing with one or two tightly related tools max.",
    "- Do not combine writing with approval. Do not combine email build with approval. Do not combine approval with broadcast delivery.",
    "",
    "Every agent task must be:",
    "- Specific enough to execute without ambiguity",
    "- Grounded in the user's memories and preferences where relevant",
    "- Assigned only tools it actually needs",
    "- Explicit about evidence standards: no placeholders, no invented facts, no invented URLs, no unverified product claims",
    "",
    "For memory/research agents:",
    "- If no relevant memory is found, output `No verified memory evidence found` and do not create sample product updates, placeholder IDs, or ready-to-fill facts.",
    "- Include exact memory IDs only when they came from provided memory results.",
    "",
    "For briefing agents:",
    "- Separate verified facts from missing facts.",
    "- Do not promote examples, placeholders, or requested categories into factual recommendations.",
    "- Tell the writer which items are safe to use and which must be omitted.",
    "",
    "For writer/producer agents:",
    "- Produce one final deliverable only, unless the user explicitly requested variants.",
    "- For newsletter/email output, require line 1 `Subject: <one subject>` and optionally line 2 `Preview: <one preview>`.",
    "- Forbid subject-line options, alternate tones, one-paragraph versions, social snippets, notes, and internal handoff text in the final draft.",
    "- Use only verified facts from prior agents; if Tallei/product evidence is missing, omit the product-update section rather than inventing it.",
    "",
    "=== STEP 4: SCHEDULE ===",
    "Match the cadence the user described:",
    "- 'weekly' without day → 0 9 * * 1 (Monday 9am UTC)",
    "- 'weekly Friday' → 0 9 * * 5",
    "- 'daily' → 0 9 * * *",
    "- 'monthly' → 0 9 1 * *",
    "- No cadence mentioned → 0 9 * * 1",
    "",
    "=== OUTPUT ===",
    "Return JSON only. Never include template names, pattern IDs, or 'preset' labels in title, summary, rationale, or tasks.",
    outputShape,
  ].join("\n");
}

function summarizeEvidence(evidence: ReturnType<typeof curateEvidence>) {
  return {
    memoryCount: evidence.memories.length,
    preferenceCount: evidence.preferences.length,
    memoryIds: evidence.memories.map((memory) => memory.id),
    preferenceIds: evidence.preferences.map((preference) => preference.id),
  };
}

function buildUserPrompt(input: {
  prompt: string;
  feedback?: string;
  templateHint?: string;
  evidence: ReturnType<typeof curateEvidence>;
  priorProposal?: DesignLoopInput["priorProposal"];
}): string {
  const sections: string[] = [
    "## User intent",
    input.prompt,
  ];

  if (input.feedback?.trim()) {
    sections.push("", "## Refinement feedback", input.feedback.trim());
  }

  if (input.templateHint?.trim()) {
    const template = getLoopTemplate(input.templateHint.trim());
    sections.push(
      "",
      "## User template hint (inspiration only — still customize)",
      template ? `${template.label}: ${template.description}` : input.templateHint,
    );
  }

  sections.push(
    "",
    "## User memories",
    input.evidence.memoryBlock,
    "",
    "## User preferences",
    input.evidence.preferenceBlock,
    "",
    input.evidence.templateCatalog,
    "",
    "## Available tools",
    input.evidence.toolCatalog,
  );

  if (input.priorProposal) {
    sections.push(
      "",
      "## Prior proposal to revise",
      JSON.stringify({
        title: input.priorProposal.title,
        summary: input.priorProposal.summary,
        agentGraph: input.priorProposal.definition.agentGraph,
        rationale: input.priorProposal.rationale,
      }, null, 2),
    );
  }

  return sections.join("\n");
}

async function callLoopArchitectLlm(input: {
  prompt: string;
  feedback?: string;
  templateHint?: string;
  classification: LoopDeliveryClassification;
  evidence: ReturnType<typeof curateEvidence>;
  priorProposal?: DesignLoopInput["priorProposal"];
  chat?: typeof loopBuilderOpenAiChat;
}): Promise<{ design: CeoDesignOutput; traceStage: LoopBuilderTraceStage }> {
  const chat = input.chat ?? loopBuilderOpenAiChat;
  const messages = [
    { role: "system" as const, content: buildSystemPrompt(input.classification) },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  const response = await chat({
    responseFormat: "json_object",
    temperature: 1,
    maxTokens: 4096,
    messages,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Loop builder returned invalid JSON");
  }

  const design = ceoDesignOutputSchema.parse(parsed);
  return {
    design,
    traceStage: loopBuilderTraceStageSchema.parse({
      stage: "loop_architect",
      model: response.model ?? loopBuilderOpenAiModel(),
      input: {
        classification: input.classification,
        evidence: summarizeEvidence(input.evidence),
        prompt: input.prompt,
        feedback: input.feedback ?? null,
        templateHint: input.templateHint ?? null,
        priorProposal: input.priorProposal
          ? {
              title: input.priorProposal.title,
              summary: input.priorProposal.summary,
              rationale: input.priorProposal.rationale,
              childCount: input.priorProposal.definition.agentGraph?.children?.length ?? 0,
            }
          : null,
        messages,
      },
      output: {
        response: response.text,
        parsedDesign: design,
      },
    }),
  };
}

function critiqueWorkflowDesign(design: CeoDesignOutput, classification: LoopDeliveryClassification): WorkflowCriticResult {
  const issues: string[] = [];
  const requiredFixes: string[] = [];
  const children = design.agentGraph.children;
  const hasApproval = children.some((child) => child.tools.some((tool) => tool.ref === "internal.email_approval_request"));
  const hasEmailBuild = children.some((child) => child.tools.some((tool) => tool.ref === "internal.email_builder_compose" || tool.ref === "internal.email_builder_render"));
  const hasBroadcast = children.some((child) => child.tools.some((tool) => tool.ref === "internal.resend_broadcast")
    || /\b(broadcast|delivery)\b/i.test(`${child.id} ${child.name}`));
  const mixedApprovalBuild = children.some((child) => {
    const refs = child.tools.map((tool) => tool.ref);
    return refs.includes("internal.email_approval_request")
      && refs.some((ref) => ref === "internal.email_builder_compose" || ref === "internal.email_builder_render");
  });
  const mixedApprovalDelivery = children.some((child) => {
    const refs = child.tools.map((tool) => tool.ref);
    return refs.includes("internal.email_approval_request") && refs.includes("internal.resend_broadcast");
  });
  const mixedBuildDelivery = children.some((child) => {
    const refs = child.tools.map((tool) => tool.ref);
    return refs.some((ref) => ref === "internal.email_builder_compose" || ref === "internal.email_builder_render")
      && refs.includes("internal.resend_broadcast");
  });
  const overloadedAgents = children.filter((child) => child.tools.length > 2);

  if (classification.subscriberBroadcastRequired && !hasBroadcast) {
    requiredFixes.push("Add a Broadcast Delivery Agent with internal.resend_broadcast.");
  }
  if (classification.subscriberBroadcastRequired && !hasEmailBuild) {
    requiredFixes.push("Add an Email Build Agent with compose/render tools.");
  }
  if (classification.externalActionRequired && !hasApproval) {
    requiredFixes.push("Add an Approval Agent with internal.email_approval_request before external delivery.");
  }
  if (mixedApprovalBuild) {
    requiredFixes.push("Split approval and email build into separate single-purpose agents.");
  }
  if (mixedApprovalDelivery || mixedBuildDelivery) {
    requiredFixes.push("Separate approval/email-build tools from broadcast delivery tools.");
  }
  if (overloadedAgents.length > 0) {
    issues.push("Some agents carry more than two tools; each spot agent should stay narrowly scoped.");
  }
  if (children.length > 7) {
    issues.push("Roster is larger than the preferred specialist range.");
  }

  return workflowCriticResultSchema.parse({
    pass: requiredFixes.length === 0,
    riskLevel: requiredFixes.length > 0 ? "medium" : "low",
    issues,
    requiredFixes,
    optionalImprovements: [],
  });
}

function finalizeLoopDesign(input: {
  design: CeoDesignOutput;
  classification: LoopDeliveryClassification;
  critic: WorkflowCriticResult;
}): FinalizedLoopDesign {
  const newsletterDelivery = input.classification.deliveryType === "newsletter"
    || isNewsletterDeliveryDefinition(input.design);
  const children = normalizeGraphResponsibilities(input.design.agentGraph.children, {
    newsletterDelivery,
    appendBroadcastDelivery: input.classification.subscriberBroadcastRequired,
  });
  const deliveryType = input.classification.deliveryType === "none" ? input.design.deliveryType : input.classification.deliveryType;
  return {
    ...input.design,
    presetId: undefined,
    deliveryType,
    strategyText: newsletterDelivery
      ? [
          input.design.strategyText.trim(),
          "",
          "Responsibility split: writer writes only; Email Build Agent composes/renders only; Approval Agent sends the approval request only; Broadcast Delivery Agent handles only post-approval recipient sync and Resend broadcast submission.",
        ].join("\n")
      : input.design.strategyText,
    builderMeta: {
      ...input.design.builderMeta,
      designedBy: "ceo_llm",
      preApproved: input.design.builderMeta.preApproved ?? true,
    },
    agentGraph: {
      ...input.design.agentGraph,
      children,
    },
    designDiagnostics: {
      deliveryClassification: input.classification,
      critic: input.critic,
    },
  };
}

export async function designLoopFromIntent(input: DesignLoopInput): Promise<{
  design: CeoDesignOutput;
  definition: LoopDefinition;
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  model: string;
  suggestedToolRefs: string[];
  trace: LoopBuilderTrace;
}> {
  const prompt = normalizePrompt(input.prompt);
  if (!prompt) throw new Error("Prompt is required");

  const [memoryResult, preferences] = await Promise.all([
    (input.testOverrides?.recallMemories ?? recallMemories)(buildMemoryQuery(prompt), input.auth, 15).catch(() => ({ memories: [] })),
    (input.testOverrides?.listPreferences ?? listPreferences)(input.auth).catch(() => []),
  ]);

  const memories = (memoryResult.memories ?? []).map((memory) => ({
    id: memory.id,
    text: memory.text,
  }));
  const selectedPreferences = preferences.slice(0, 8).map((preference) => ({
    id: preference.id,
    text: preference.text,
    category: preference.category ?? null,
  }));

  const classification = classifyDeliveryIntent({
    prompt,
    feedback: input.feedback,
    templateHint: input.templateHint,
  });
  const evidence = curateEvidence({ memories, preferences: selectedPreferences });
  const classificationTrace = loopBuilderTraceStageSchema.parse({
    stage: "delivery_classification",
    model: "deterministic",
    input: {
      prompt,
      feedback: input.feedback ?? null,
      templateHint: input.templateHint ?? null,
    },
    output: classification,
  });
  const evidenceTrace = loopBuilderTraceStageSchema.parse({
    stage: "evidence_curation",
    model: "deterministic",
    input: {
      memories,
      preferences: selectedPreferences,
    },
    output: {
      memoryCount: evidence.memories.length,
      preferenceCount: evidence.preferences.length,
      memoryIds: evidence.memories.map((memory) => memory.id),
      preferenceIds: evidence.preferences.map((preference) => preference.id),
    },
  });
  const architectResult = await callLoopArchitectLlm({
    prompt,
    feedback: input.feedback,
    templateHint: input.templateHint,
    classification,
    evidence,
    priorProposal: input.priorProposal,
    chat: input.testOverrides?.chat,
  });
  const critic = critiqueWorkflowDesign(architectResult.design, classification);
  const criticTrace = loopBuilderTraceStageSchema.parse({
    stage: "workflow_critic",
    model: "deterministic",
    input: {
      design: summarizeAgentGraph(architectResult.design.agentGraph),
      classification,
    },
    output: critic,
  });
  const designWithoutTrace = finalizeLoopDesign({ design: architectResult.design, classification, critic });
  const finalizationTrace = loopBuilderTraceStageSchema.parse({
    stage: "loop_finalizer",
    model: "deterministic",
    input: {
      design: summarizeAgentGraph(architectResult.design.agentGraph),
      classification,
      critic,
    },
    output: {
      deliveryType: designWithoutTrace.deliveryType ?? null,
      presetId: designWithoutTrace.presetId ?? null,
      childAgents: designWithoutTrace.agentGraph.children.map((child) => ({
        id: child.id,
        name: child.name,
        tools: child.tools.map((tool) => tool.ref),
      })),
      diagnostics: designWithoutTrace.designDiagnostics,
    },
  });
  const trace = loopBuilderTraceSchema.parse({
    stages: [
      classificationTrace,
      evidenceTrace,
      architectResult.traceStage,
      criticTrace,
      finalizationTrace,
    ],
  });
  const design = {
    ...designWithoutTrace,
    trace,
    designDiagnostics: {
      ...designWithoutTrace.designDiagnostics,
      trace,
    },
  };

  const model = loopBuilderOpenAiModel();
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: prompt,
    design: {
      ...design,
      builderMeta: { ...design.builderMeta, model, designDiagnostics: design.designDiagnostics },
    },
  });

  const rosterValidation = await validateAgentRoster({
    agents: design.agentGraph.children.map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      tools: child.tools,
    })),
    definition: getEffectiveLoopConstraints(definition),
    auth: input.auth,
    strictConnectors: false,
  });
  if (!rosterValidation.ok) {
    const message = (rosterValidation.issues ?? []).map((issue) => issue.message).join("; ");
    throw new Error(`CEO designed invalid roster: ${message}`);
  }

  return {
    design,
    definition,
    memories,
    preferences: selectedPreferences,
    model,
    suggestedToolRefs: collectSuggestedToolRefs(design.agentGraph),
    trace,
  };
}

export function channelsFromDesign(channels: LoopStageApprovalChannel[]): LoopStageApprovalChannel[] {
  return channels.length > 0 ? channels : ["primary"];
}

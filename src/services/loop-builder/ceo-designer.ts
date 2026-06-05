import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences, recallMemories } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import { formatTemplateCatalogForPrompt, getLoopTemplate } from "../loop-executor/templates/registry.js";
import { getEffectiveLoopConstraints, listLoopTools, validateAgentRoster } from "../loop-executor/tool-catalog.js";
import {
  loopAgentGraphSchema,
  loopStageApprovalChannelInputSchema,
  type LoopAgentGraph,
  type LoopAgentGraphChild,
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
  deliveryType: z.string().min(1).optional(),
  presetId: z.string().min(1).optional(),
  builderMeta: z.object({
    designedBy: z.literal("ceo_llm").default("ceo_llm"),
    preApproved: z.boolean().default(true),
    // sourceTemplateIds intentionally omitted from LLM schema — we don't want model labelling patterns
  }),
  rationale: z.array(z.string().min(1)).default([]),
  suggestedChannels: z.array(loopStageApprovalChannelInputSchema).default(["primary"]),
});

export type CeoDesignOutput = z.infer<typeof ceoDesignOutputSchema>;

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

function childToolRefs(child: LoopAgentGraphChild): string[] {
  return child.tools.map((tool) => tool.ref.trim().toLowerCase()).filter(Boolean);
}

function isNewsletterDeliveryDesign(design: Pick<CeoDesignOutput, "deliveryType" | "presetId">): boolean {
  return design.deliveryType?.trim().toLowerCase() === "newsletter"
    || design.presetId?.trim().toLowerCase() === "newsletter"
    || design.presetId?.trim().toLowerCase() === "newsletter_v1";
}

function isApprovalEmailBuildAgent(child: LoopAgentGraphChild): boolean {
  const refs = childToolRefs(child).join(" ");
  const roleKey = `${child.id} ${child.name}`.toLowerCase();
  return refs.includes("internal.email_approval_request")
    || refs.includes("internal.email_builder_compose")
    || refs.includes("internal.email_builder_render")
    || roleKey.includes("approval");
}

function isBroadcastDeliveryAgent(child: LoopAgentGraphChild): boolean {
  const refs = childToolRefs(child).join(" ");
  const roleKey = `${child.id} ${child.name}`.toLowerCase();
  return refs.includes("internal.resend_broadcast") || roleKey.includes("broadcast") || roleKey.includes("delivery");
}

function isWriterAgent(child: LoopAgentGraphChild): boolean {
  const key = `${child.id} ${child.name} ${child.task}`.toLowerCase();
  return key.includes("writer") || key.includes("write") || key.includes("draft");
}

function normalizeCeoDesignResponsibilities(design: CeoDesignOutput): CeoDesignOutput {
  const newsletterDelivery = isNewsletterDeliveryDesign(design);
  const children = design.agentGraph.children.map((child) => {
    if (isApprovalEmailBuildAgent(child)) {
      return {
        ...child,
        id: child.id || "approval_email_build",
        name: "Approval & Email Build Agent",
        task: [
          "Review the producer's final draft, ask the operator any approval questions, compose/render the email, and send the approval email only.",
          "Do not sync recipients, upload contacts, submit a Resend broadcast, or describe broadcast delivery as your responsibility.",
        ].join(" "),
        tools: child.tools.filter((tool) => [
          "internal.email_approval_request",
          "internal.email_builder_compose",
          "internal.email_builder_render",
        ].includes(tool.ref)),
      };
    }

    if (newsletterDelivery && isBroadcastDeliveryAgent(child)) {
      return {
        ...child,
        id: child.id || "broadcast_delivery",
        name: "Broadcast Delivery Agent",
        task: [
          "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
          "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
        ].join(" "),
        tools: child.tools.filter((tool) => tool.ref !== "internal.email_approval_request"
          && tool.ref !== "internal.email_builder_compose"
          && tool.ref !== "internal.email_builder_render"),
      };
    }

    if (newsletterDelivery && isWriterAgent(child)) {
      return {
        ...child,
        name: /newsletter/i.test(child.name) ? child.name : "Newsletter Writer",
        task: [
          "Write one subscriber-ready newsletter draft only, grounded in prior research and verified facts.",
          "Do not ask approval questions, prepare email builder output, upload contacts, or send/broadcast anything.",
        ].join(" "),
      };
    }

    return child;
  });

  if (newsletterDelivery && !children.some(isBroadcastDeliveryAgent)) {
    children.push({
      id: "broadcast_delivery",
      name: "Broadcast Delivery Agent",
      task: [
        "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
        "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
      ].join(" "),
      tools: [{ ref: "internal.resend_broadcast" }],
    });
  }

  return {
    ...design,
    presetId: newsletterDelivery ? undefined : design.presetId,
    deliveryType: newsletterDelivery ? "newsletter" : design.deliveryType,
    strategyText: newsletterDelivery
      ? [
          design.strategyText.trim(),
          "",
          "Responsibility split: writer writes only; Approval & Email Build Agent handles review questions, email compose/render, and the approval email only; Broadcast Delivery Agent handles only post-approval recipient sync and Resend broadcast submission.",
        ].join("\n")
      : design.strategyText,
    agentGraph: {
      ...design.agentGraph,
      children,
    },
  };
}

function buildSystemPrompt(): string {
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
    presetId: "omit unless the user explicitly asks for a legacy fixed preset",
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
    "Read the user's intent and set delivery fields accordingly:",
    "",
    "→ BROADCAST TO SUBSCRIBERS / AUDIENCE / MAILING LIST:",
    "  Triggers: 'subscribers', 'mailing list', 'email list', 'send to audience', 'broadcast', 'distribute to readers'",
    "  Action: set deliveryType: 'newsletter' and omit presetId.",
    "  Do not use a fixed newsletter preset/template unless the user explicitly requests a legacy fixed preset.",
    "  This activates: approval → recipient upload → email broadcast as the delivery mechanism, while the CEO still designs the bespoke agent roster.",
    "  The final approval/email build agent MUST include tools: internal.email_approval_request, internal.email_builder_compose, internal.email_builder_render",
    "  Keep responsibilities separate: writer writes only; approval/email build agent reviews, asks questions, and prepares/sends the approval email only; broadcast delivery syncs recipients and sends Resend only after approval + recipient upload.",
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
    "4. Approve/email build (always before any delivery; do not perform delivery here)",
    "5. Deliver (only if Step 2 identified a delivery target — use the right tools for that delivery type and do not repeat approval/build work)",
    "",
    "Hard boundary rule:",
    "- Every child agent must do exactly one thing. Do not combine writing with approval. Do not combine approval/email build with broadcast delivery. Do not combine broadcast delivery with email approval sending.",
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

function buildUserPrompt(input: {
  prompt: string;
  feedback?: string;
  templateHint?: string;
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
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
    formatMemoriesForPrompt(input.memories),
    "",
    "## User preferences",
    formatPreferencesForPrompt(input.preferences),
    "",
    formatTemplateCatalogForPrompt(),
    "",
    "## Available tools",
    formatToolCatalogForPrompt(),
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

async function callCeoDesignerLlm(input: {
  prompt: string;
  feedback?: string;
  templateHint?: string;
  memories: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  priorProposal?: DesignLoopInput["priorProposal"];
  chat?: typeof loopBuilderOpenAiChat;
}): Promise<CeoDesignOutput> {
  const chat = input.chat ?? loopBuilderOpenAiChat;
  const response = await chat({
    responseFormat: "json_object",
    temperature: 1,
    maxTokens: 4096,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Loop builder returned invalid JSON");
  }

  const design = normalizeCeoDesignResponsibilities(ceoDesignOutputSchema.parse(parsed));
  return {
    ...design,
    builderMeta: {
      ...design.builderMeta,
      designedBy: "ceo_llm",
      preApproved: design.builderMeta.preApproved ?? true,
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

  const design = await callCeoDesignerLlm({
    prompt,
    feedback: input.feedback,
    templateHint: input.templateHint,
    memories,
    preferences: selectedPreferences,
    priorProposal: input.priorProposal,
    chat: input.testOverrides?.chat,
  });

  const model = loopBuilderOpenAiModel();
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: prompt,
    design: {
      ...design,
      builderMeta: { ...design.builderMeta, model },
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
  };
}

export function channelsFromDesign(channels: LoopStageApprovalChannel[]): LoopStageApprovalChannel[] {
  return channels.length > 0 ? channels : ["primary"];
}

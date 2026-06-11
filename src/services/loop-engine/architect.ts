/**
 * architect.ts — Preset-free loop design via LLM architect + enforcing critic.
 */

import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
import { getEffectiveLoopConstraints, listAvailableLoopToolsForAuth, validateAgentRoster } from "../loop-executor/tool-catalog.js";
import {
  LOOP_ENGINE_VERSION,
  loopStageApprovalChannelInputSchema,
  type LoopDefinition,
  type LoopStageApprovalChannel,
} from "../loop-executor/types.js";
import { loopBuilderOpenAiChat, loopBuilderOpenAiModel } from "../loop-builder/openai-chat.js";
import {
  ENGINE_MAX_CRITIC_RETRIES,
  architectOutputToAgentGraph,
  assertDeliveryRouting,
  deliveryTypeFromRouting,
  loopArchitectOutputSchema,
  type NoSlopSpecSnapshot,
  type LoopArchitectOutput,
  type WorkflowCriticResult,
} from "./contracts.js";
import { critiqueLoopDesign } from "./critic.js";
import { normalizeArchitectOutput } from "./normalize-architect.js";
import { formatMemoriesForArchitect, recallForDesigner } from "./recall.js";
import {
  formatWorkflowUserProfile,
  loadWorkflowUserProfile,
} from "./workflow-user-profile.js";
import { buildToolSpecRegistry, filterToolSpecRegistryForSpec, renderOutcomesForArchitect, renderToolsForArchitect, type ToolSpecRegistry } from "../tool-spec/index.js";
import { connectorActionToolRef } from "../tool-spec/tool-contracts.js";
import { repairArchitectDesignForSpecWithInputs } from "./repair-architect.js";
import {
  canonicalizeInputRequirementsList,
  extractInputRequirementContext,
} from "./input-surfaces.js";

export type DesignerTestOverrides = {
  chat?: typeof loopBuilderOpenAiChat;
  recallForDesigner?: typeof recallForDesigner;
  listPreferences?: typeof listPreferences;
};

const loopBuilderTraceStageSchema = z.object({
  stage: z.string().min(1),
  model: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
});

export const loopBuilderTraceSchema = z.object({
  stages: z.array(loopBuilderTraceStageSchema).default([]),
});

export type LoopBuilderTrace = z.infer<typeof loopBuilderTraceSchema>;

export type DesignLoopInput = {
  auth: AuthContext;
  prompt: string;
  feedback?: string;
  noSlopSpec?: NoSlopSpecSnapshot;
  priorProposal?: {
    title: string;
    summary: string;
    definition: { agentGraph?: { children: Array<{ id: string; name: string; tools: Array<{ ref: string }> }> } };
    rationale: string[];
  };
  testOverrides?: DesignerTestOverrides;
};

async function formatToolCatalog(auth: AuthContext, noSlopSpec?: NoSlopSpecSnapshot): Promise<string> {
  const baseTools = await listAvailableLoopToolsForAuth(auth);
  const writeTools = (noSlopSpec?.specJson.connectorPolicy.allowedWriteActions ?? []).map((action) => ({
    ref: connectorActionToolRef(action),
    description: `${action.description ?? action.actionSlug} (approved ${action.risk} connector action; must use pre_send gate)`,
    riskLevel: action.risk === "write" ? "medium" : "high",
  }));
  return [...baseTools, ...writeTools]
    .map((tool) => `- ${tool.ref}: ${tool.description} (risk: ${tool.riskLevel})`)
    .join("\n");
}

function formatPreferences(preferences: Array<{ id: string; text: string; category?: string | null }>): string {
  if (preferences.length === 0) return "No saved preferences.";
  return preferences.map((p, i) => `${i + 1}. [${p.id}] ${p.text}`).join("\n");
}

function buildArchitectSystemPrompt(outcomesMarkdown: string): string {
  const outputExample = JSON.stringify({
    title: "Weekly AI newsletter",
    summary: "Research this week's AI news, draft a cited newsletter, and pause for review.",
    strategyText: "Web research, optional memory context, synthesize draft — no operator paste at run_start.",
    inputsRequired: [],
    inputRequirements: [],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "web_research",
        name: "Research Agent",
        goal: "Find recent news articles on the requested topic with source URLs and snippets",
        task: "Search the web for the most relevant and recent articles. Return raw results with URLs, titles, and snippets.",
        tool: "internal.web_search",
        artifactRole: "source_evidence",
        inputContract: { description: "Search query derived from the loop goal", schema: { query: "string", recency_days: "number" } },
        outputContract: { description: "Raw search results from Exa API", schema: { text: "string", model: "string", provider: "string", sources: [{ title: "string", url: "string", snippet: "string" }] } },
        doneCriteria: ["At least 5 sources returned", "Each source has title, url, and snippet", "Sources are from credible news sources"],
        gate: { type: "source_confirmation", question: "Select which sources to include. Add custom URLs if needed." },
        operatorSurface: "review.sources",
      },
      {
        id: "memory_context",
        name: "Memory Agent",
        goal: "Recall relevant internal memories for the newsletter topic",
        task: "Search memories for product updates, decisions, and context related to the approved web sources.",
        tool: "internal.memory_search",
        artifactRole: "source_evidence",
        inputContract: { description: "Topic from approved web sources", schema: { query: "string" } },
        outputContract: { description: "Validated memories with excerpts", schema: { sources: [{ id: "string", text: "string" }] } },
        doneCriteria: ["Returns memory excerpts with ids", "Query is focused on the newsletter topic"],
        gate: { type: "memory_confirmation", question: "Select which memories the writer may use." },
        operatorSurface: "review.memories",
      },
      {
        id: "newsletter_writer",
        name: "Writer Agent",
        goal: "Produce one final-use newsletter email for human review",
        task: "Synthesize research sources into a newsletter with Subject, Preview, and body sections. Cite sources inline and omit all workflow scaffolding, placeholder notes, and send-plan text.",
        tool: "internal.llm_only",
        artifactRole: "draft_body",
        inputContract: { description: "Research handoff from prior agent", schema: { handoff: { web_research: { sources: "array" } } } },
        outputContract: { description: "One final-use email in canonical email_markdown format", schema: { format: "email_markdown", grammar: "Subject line, optional Preview line, blank line, Markdown body" } },
        doneCriteria: ["Includes exactly one Subject line", "Includes at most one Preview line", "Includes one complete Markdown email body", "Contains no delivery, sending, boilerplate, or placeholder claims"],
        gate: { type: "draft_review", question: "Review this newsletter email. Approve to continue, or edit to improve it." },
        renderTarget: "canvas.email",
        operatorSurface: "review.email",
      },
    ],
    rationale: ["Minimal roster tailored to producing a reviewed artifact"],
    suggestedChannels: ["primary"],
  }, null, 2);

  return [
    "You are a loop architect for Tallei. Generate executable recurring agent loops from reviewed human specs and API/tool contracts.",
    "Use role names people understand immediately: child roles should be named as Agents, and the parent coordinator should be an Orchestrator.",
    "When a no-slop spec is provided, it is the behavioral source of truth. Satisfy it directly and do not override it with guesses from the raw prompt.",
    "Do NOT mention template IDs or preset names.",
    "Every child agent must have exactly ONE tool, exactly ONE task, a clear goal (success condition), inputContract, outputContract, and 1-8 doneCriteria.",
    "=== ARTIFACT ROLES, OUTPUT FORMAT & APPROVAL GATES ===",
    "For EVERY agent, decide:",
    "  1. artifactRole — how this agent contributes to the final loop outcome:",
    '     "source_evidence" — raw research/memory (handoff only, not the final artifact)',
    '     "draft_body" — produces a draft artifact',
    '     "final_preview" — produces a final preview artifact',
    '     "delivery" — executes an approved external-effect tool when the reviewed workflow calls for one',
    "  2. outputContract — exact shape the agent produces (match tool outputSchema for short-circuit tools)",
    "  3. gate — human approval type when the agent pauses:",
    '     missing_input — operator must PASTE text (sprint notes, briefs). Use ONLY on a dedicated Input Validator agent for run_start inputRequirements.',
    '     memory_confirmation — operator SELECTS which memories to include',
    '     source_confirmation — operator SELECTS web search sources and may ADD custom URLs/titles/snippets',
    '     draft_review — operator REVIEWS a draft in the canvas; can approve as-is or edit to improve',
    '     pre_send — operator CONFIRMS an external side effect when the selected tool contract requires approval',
    "  4. renderTarget — optional specialized renderer/editor for the output (NOT a tool ref):",
    '     "canvas.email" — editable email workspace when the operator should edit the email visually',
    '     "canvas.preview" — read-only rendered email preview when visual review is useful',
    "  5. operatorSurface — the semantic editor used during review:",
    '     "review.sources" — editable source checklist; use for source arrays, never a raw text editor',
    '     "review.memories" — editable memory checklist; use for memory arrays',
    '     "review.email" — email canvas editor',
    '     "review.preview" — read-only rendered final preview',
    '     "review.draft" — prose/markdown editor for unstructured writing',
    '     "confirm.send" — final send confirmation',
    "",
    "SINGLE-RESPONSIBILITY RULES:",
    "  - One agent = one tool = one task. Do not combine distinct duties (research + write, summarize + draft) in one agent.",
    "  - If an agent needs to do multiple things, split it into multiple agents and delegate through the roster.",
    "  - Example: 'Research Agent' searches, 'Summarization Agent' synthesizes, 'Writer Agent' drafts — never one agent doing all three.",
    "  - Example: 'Pre-send Specialist Agent' only collects recipients and generates preview; 'Delivery Agent' only sends. Never combine.",
    "",
    "GATE RULES BY TOOL TYPE:",
    "  - Choose gates only when human judgment/input is needed for that agent's output.",
    "  - NEVER put pre_send on internal.llm_only, internal.web_search, internal.memory_search, or composio.<toolkit>.search.",
    "  - NEVER create a separate Pre-send Specialist Agent with internal.llm_only. If text review is needed, use draft_review; if external execution is needed, put pre_send on the exact approved external-effect action agent.",
    "  - Search agents (internal.web_search, internal.memory_search) may run without a gate, or use source_confirmation / memory_confirmation when the operator should curate results. NEVER use missing_input on search agents.",
    '  - Match structured outputs to semantic editors: source arrays → review.sources, memory arrays → review.memories, editable email_markdown → canvas.email + review.email, read-only final email → canvas.preview + review.preview, unstructured prose → review.draft.',
    "  - Never expose structured source or memory output as a raw textarea when a checklist surface can edit the underlying items.",
    "  - Memory agents may run without a gate, or use memory_confirmation when the operator should curate memories.",
    "  - When inputRequirements declare run_start content inputs, add an Input Validator agent as the FIRST roster step with internal.llm_only and missing_input gate. Its sole job is collecting/confirming operator inputs — not research or drafting.",
    "  - internal.llm_only writing email/newsletter/digest may use plain structured output, markdown, canvas.email, or canvas.preview depending on the workflow.",
    "  - For email/newsletter output, the body must be final-use copy only: no boilerplate intro, no send-plan notes, no placeholder guidance, no signature scaffolding, and no commentary about the draft.",
    "  - External-effect tools must use the approval gate declared by their tool contract.",
    "  - Render recommendations in tool contracts are advisory. Choose renderTarget from workflow output/review needs, or omit it.",
    "",
    "inputsRequired / run_start inputRequirements are ONLY for operator-pasted CONTENT when the spec explicitly requires it (internal team_email sync → sprint_notes).",
    "inputsRequired MUST be a string array of keys only (e.g. [\"sprint_notes\"]). Put structured objects in inputRequirements, never inside inputsRequired.",
    "Research/newsletter/subscriber_list workflows do NOT use sprint_notes or run_start paste — content comes from web_search and memory_search.",
    "inputRequirements declares structured runtime checkpoints: key, surface, when (run_start | before_send). Copy spec inputRequirements exactly; do not add run_start keys the spec omits.",
    "before_send recipient upload: { key: recipients, surface: input.contacts_csv }. Send approval: { key: confirm_send, surface: confirm.send }.",
    "Do NOT invent keys like pre_send_confirm, sync_to_team, or sprint_notes for newsletters — use confirm_send at before_send only.",
    "When the spec requires run_start inputs (team sync only), prepend an Input Validator agent — do NOT attach missing_input to Research or Writer agents.",
    "Apply the mandatory user profile for tone, writing style, sign-off, and identity in agent goals and output contracts.",
    "NEVER put delivery configuration in inputsRequired (subscriber_list_id, audience_id, recipient_email, mailing_list).",
    "External action configuration comes from connectorPolicy and tool assignment config, not invented inputs.",
    "",
    'Default to delivery: { "provider": "none", "target": "none" } unless the approved no-slop spec includes connectorPolicy.allowedWriteActions.',
    "If the approved spec allows an external effect, delivery.provider must be the exact approved connector action tool ref and the agent must use the contract approval gate.",
    "Choose external tools by matching skillTags, resources, effect, schemas, approval, and renderRecommendations from the tool contract.",
    "Keep rosters minimal (2-6 agents). End with the artifact type and gate pattern that best fits the approved spec unless it explicitly authorizes a gated connector send action.",
    "Copy tool refs exactly from the catalog.",
    "For internal.memory_search configs, write a focused query for the requested output. Do not ask for broad memory categories unless the user explicitly needs them.",
    "",
    "=== TOOL OUTPUT CONTRACTS & AGENT HANDOFF ===",
    "CRITICAL: When designing agents, you MUST use the exact tool output schemas provided in the TOOL REFERENCE section.",
    "For each agent, generate inputContract and outputContract based on the tool's actual output schema:",
    "  - inputContract.schema must match what the agent expects to receive (from prior agent handoff or tool output)",
    "  - outputContract.schema must match the tool's outputSchema (for short-circuit tools) or the LLM-generated output (for llm_only tools)",
    "",
    "For SHORT-CIRCUIT tools (executionMode short_circuit):",
    "  - The agent output IS the raw tool result (no LLM synthesis)",
    "  - doneCriteria must validate the RAW tool output format, not expect synthesized content",
    "  - Example: For web_search, doneCriteria should check 'sources array has N items', 'each source has title, url, snippet' — NOT '4-6 ranked stories with summaries'",
    "  - The next agent in the flow receives this raw output via handoff and must synthesize it",
    "",
    "For LLM_SYNTHESIS tools (executionMode llm_assisted):",
    "  - The agent receives prior agent outputs via handoff and synthesizes them",
    "  - inputContract.schema should describe what the agent expects from upstream agents",
    "  - outputContract.schema should describe the synthesized output (e.g., newsletter draft, summary)",
    "  - doneCriteria should validate the synthesized content quality",
    '  - Any agent with renderTarget "canvas.email" MUST use outputContract.schema.format = "email_markdown". Its only representation is: Subject line, optional Preview line, blank line, Markdown body.',
    '  - Email canvas agents MUST declare outputContract.schema.format = "email_markdown"; format restrictions belong in the output contract, not magic doneCriteria wording.',
    "",
    "AGENT HANDOFF FORMAT:",
    "  - Each agent's output is passed to downstream agents as `handoff.<agent_id>`",
    "  - Downstream agents receive the full output object (text, data, sources, etc.)",
    "  - Design inputContract/outputContract to explicitly document what is passed between agents",
    "  - Example: If Research Agent uses web_search, Draft Agent's inputContract should reference `handoff.web_research.sources` array",
    "",
    "=== AVAILABLE CAPABILITIES ===",
    outcomesMarkdown,
    "",
    "=== SCHEDULE ===",
    "schedule.cron MUST be a standard 5-field cron: minute hour day-of-month month day-of-week.",
    "Examples: daily -> 0 9 * * * | weekly Monday -> 0 9 * * 1 | weekly Friday -> 0 9 * * 5 | monthly -> 0 9 1 * *",
    "Never use 6 fields, seconds, or day names like MON. Use numeric day-of-week (0=Sunday, 1=Monday).",
    "If cadence is unclear, default to 0 9 * * 1 (Monday 09:00 UTC).",
    "",
    "Return JSON matching this shape:",
    outputExample,
  ].join("\n");
}

function buildArchitectUserPrompt(input: {
  prompt: string;
  feedback?: string;
  memories: string;
  userProfile?: string;
  preferences: string;
  priorProposal?: DesignLoopInput["priorProposal"];
  criticFixes?: string[];
  noSlopSpec?: NoSlopSpecSnapshot;
  toolCatalog: string;
  outcomesMarkdown: string;
  toolsMarkdown: string;
}): string {
  const sections = [
    `User intent:\n${input.prompt}`,
    input.userProfile
      ? `User profile (mandatory — tone, voice, writing style, identity, sign-off):\n${input.userProfile}`
      : null,
    input.noSlopSpec
      ? [
          "Approved no-slop spec (behavioral source of truth):",
          input.noSlopSpec.bodyMarkdown,
          "",
          "Normalized no-slop spec JSON:",
          JSON.stringify(input.noSlopSpec.specJson, null, 2),
          "",
          "Canonical inputRequirements (copy these keys/surfaces exactly — do not rename):",
          JSON.stringify(
            canonicalizeInputRequirementsList(
              input.noSlopSpec.specJson.inputRequirements ?? [],
              extractInputRequirementContext(input.noSlopSpec.specJson as unknown as Record<string, unknown>),
            ),
            null,
            2,
          ),
        ].join("\n")
      : null,
    input.feedback ? `Feedback:\n${input.feedback}` : null,
    `Prompt-specific recalled memories (with ids and scores):\n${input.memories}`,
    `Preferences:\n${input.preferences}`,
    `Tool catalog:\n${input.toolCatalog}`,
    "",
    "=== TOOL REFERENCE (for agent assignment) ===",
    input.toolsMarkdown,
    input.priorProposal
      ? `Prior proposal (revise, do not copy blindly):\n${JSON.stringify(input.priorProposal, null, 2)}`
      : null,
    input.criticFixes?.length
      ? `Required fixes from critic (address all):\n${input.criticFixes.map((f) => `- ${f}`).join("\n")}`
      : null,
  ].filter(Boolean);
  return sections.join("\n\n");
}

async function callArchitectLlm(input: {
  prompt: string;
  feedback?: string;
  memories: string;
  userProfile?: string;
  preferences: string;
  priorProposal?: DesignLoopInput["priorProposal"];
  criticFixes?: string[];
  noSlopSpec?: NoSlopSpecSnapshot;
  toolCatalog: string;
  outcomesMarkdown: string;
  toolsMarkdown: string;
  chat?: typeof loopBuilderOpenAiChat;
}): Promise<{ design: LoopArchitectOutput; model: string }> {
  const chat = input.chat ?? loopBuilderOpenAiChat;
  const response = await chat({
    responseFormat: "json_object",
    temperature: 0.3,
    maxTokens: 4096,
    reasoningEffort: "minimal",
    messages: [
      { role: "system", content: buildArchitectSystemPrompt(input.outcomesMarkdown) },
      { role: "user", content: buildArchitectUserPrompt(input) },
    ],
  });
  
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.text);
  } catch (parseError) {
    throw new Error(`Failed to parse architect LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\nResponse text (first 500 chars):\n${response.text.slice(0, 500)}`);
  }
  
  const parsed = loopArchitectOutputSchema.parse(parsedJson);
  const design = repairArchitectDesignForSpecWithInputs(normalizeArchitectOutput({
    ...parsed,
    schedule: {
      cron: normalizeDesignCron(parsed.schedule.cron, input.prompt),
      timezone: parsed.schedule.timezone?.trim() || "UTC",
    },
  }, input.noSlopSpec), input.noSlopSpec, input.prompt);
  assertDeliveryRouting(design.delivery);
  return { design, model: response.model };
}

export async function designLoopFromIntent(input: DesignLoopInput): Promise<{
  design: LoopArchitectOutput & { agentGraph: ReturnType<typeof architectOutputToAgentGraph> };
  definition: LoopDefinition;
  memories: Array<{ id: string; text: string; score: number }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  model: string;
  suggestedToolRefs: string[];
  suggestedChannels: LoopStageApprovalChannel[];
  trace: LoopBuilderTrace;
  critic: WorkflowCriticResult;
}> {
  const prompt = input.prompt.trim().replace(/\s+/g, " ");
  if (!prompt) throw new Error("Prompt is required");

  const recall = input.testOverrides?.recallForDesigner ?? recallForDesigner;
  const listPrefs = input.testOverrides?.listPreferences ?? listPreferences;

  const [userProfile, preferences] = await Promise.all([
    loadWorkflowUserProfile(input.auth).catch(() => null),
    listPrefs(input.auth).catch(() => []),
  ]);
  const memories = await recall(input.prompt, input.auth, { profile: userProfile }).catch(() => []);
  const selectedPreferences = preferences.slice(0, 8).map((p) => ({
    id: p.id,
    text: p.text,
    category: p.category ?? null,
  }));

  const memoryBlock = formatMemoriesForArchitect(
    memories.filter((memory) => !memory.metadata?.profile),
  );
  const userProfileBlock = userProfile ? formatWorkflowUserProfile(userProfile) : "";
  const preferenceBlock = formatPreferences(selectedPreferences);
  const toolCatalog = await formatToolCatalog(input.auth, input.noSlopSpec);

  const toolSpecRegistry = filterToolSpecRegistryForSpec(
    await buildToolSpecRegistry(input.auth),
    input.noSlopSpec,
  );
  const outcomesMarkdown = renderOutcomesForArchitect(toolSpecRegistry);
  const toolsMarkdown = renderToolsForArchitect(toolSpecRegistry);

  const evidenceTrace = loopBuilderTraceStageSchema.parse({
    stage: "evidence_curation",
    model: "semantic_recall",
    input: { prompt },
    output: {
      memoryCount: memories.length,
      memoryIds: memories.map((m) => m.id),
      preferenceCount: selectedPreferences.length,
      userProfileMemoryIds: userProfile?.memoryIds ?? [],
    },
  });

  let design: LoopArchitectOutput | null = null;
  let critic: WorkflowCriticResult | null = null;
  let architectTrace: z.infer<typeof loopBuilderTraceStageSchema> | null = null;
  let criticTrace: z.infer<typeof loopBuilderTraceStageSchema> | null = null;
  let model = loopBuilderOpenAiModel();
  let criticFixes: string[] = [];

  for (let attempt = 0; attempt <= ENGINE_MAX_CRITIC_RETRIES; attempt += 1) {
    const result = await callArchitectLlm({
      prompt,
      feedback: input.feedback,
      memories: memoryBlock,
      userProfile: userProfileBlock,
      preferences: preferenceBlock,
      priorProposal: input.priorProposal,
      criticFixes: attempt > 0 ? criticFixes : undefined,
      noSlopSpec: input.noSlopSpec,
      toolCatalog,
      outcomesMarkdown,
      toolsMarkdown,
      chat: input.testOverrides?.chat,
    });
    design = result.design;
    model = result.model;
    critic = critiqueLoopDesign(design, input.noSlopSpec);

    architectTrace = loopBuilderTraceStageSchema.parse({
      stage: "loop_architect",
      model,
      input: { attempt, prompt, criticFixes: attempt > 0 ? criticFixes : [] },
      output: {
        agentCount: design.agents.length,
        delivery: design.delivery,
        inputsRequired: design.inputsRequired,
        noSlopSpecId: input.noSlopSpec?.id,
      },
    });

    criticTrace = loopBuilderTraceStageSchema.parse({
      stage: "workflow_critic",
      model: "deterministic",
      input: { attempt },
      output: critic,
    });

    if (critic.pass) break;
    criticFixes = critic.requiredFixes;
    if (attempt === ENGINE_MAX_CRITIC_RETRIES) {
      throw new Error(`Loop architect failed critic after ${ENGINE_MAX_CRITIC_RETRIES} retries: ${criticFixes.join("; ")}`);
    }
  }

  if (!design || !critic || !architectTrace || !criticTrace) {
    throw new Error("Loop architect produced no design");
  }

  const agentGraph = architectOutputToAgentGraph(design);
  const deliveryType = deliveryTypeFromRouting(design.delivery);
  const suggestedChannels: LoopStageApprovalChannel[] = [];
  for (const ch of design.suggestedChannels) {
    const parsed = loopStageApprovalChannelInputSchema.safeParse(ch);
    if (parsed.success) suggestedChannels.push(parsed.data);
  }

  const trace = loopBuilderTraceSchema.parse({
    stages: [evidenceTrace, architectTrace, criticTrace],
  });

  const definition = buildLoopDefinitionFromCeoDesign({
    goal: prompt,
    design: {
      agentGraph,
      schedule: design.schedule,
      deliveryType,
      builderMeta: {
        designedBy: "loop_architect",
        engineVersion: LOOP_ENGINE_VERSION,
        model,
        preApproved: true,
        ...(input.noSlopSpec ? { noSlopSpec: input.noSlopSpec } : {}),
        agentSpecGeneration: {
          mode: "hybrid",
          model,
          generatedAt: new Date().toISOString(),
        },
        designDiagnostics: { critic, trace, delivery: design.delivery, inputsRequired: design.inputsRequired },
        ...(userProfile ? { workflowUserProfile: userProfile } : {}),
      },
    },
    delivery: design.delivery,
    connectorPolicy: input.noSlopSpec?.specJson.connectorPolicy,
    inputsRequired: design.inputsRequired,
    inputRequirements: design.inputRequirements,
    engineVersion: LOOP_ENGINE_VERSION,
  });

  const rosterValidation = await validateAgentRoster({
    agents: agentGraph.children.map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      goal: child.goal,
      tools: child.tools,
      doneCriteria: child.doneCriteria,
      gate: child.gate,
      outputArtifactId: child.outputArtifactId,
    })),
    definition: getEffectiveLoopConstraints(definition),
    auth: input.auth,
    strictConnectors: false,
  });
  if (!rosterValidation.ok) {
    const message = (rosterValidation.issues ?? []).map((issue) => issue.message).join("; ");
    throw new Error(`Architect designed invalid roster: ${message}`);
  }

  const suggestedToolRefs = [...new Set(agentGraph.children.flatMap((c) => c.tools.map((t) => t.ref)))];

  return {
    design: {
      ...design,
      agentGraph,
    },
    definition,
    memories: memories.map((m) => ({ id: m.id, text: m.text, score: m.score })),
    preferences: selectedPreferences,
    model,
    suggestedToolRefs,
    suggestedChannels,
    trace,
    critic,
  };
}

export function channelsFromDesign(channels: LoopStageApprovalChannel[]): LoopStageApprovalChannel[] {
  return channels.length > 0 ? channels : ["primary"];
}

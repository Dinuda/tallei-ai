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
import { buildToolSpecRegistry, filterToolSpecRegistryForSpec, renderOutcomesForArchitect, renderToolsForArchitect, type ToolSpecRegistry } from "../tool-spec/index.js";
import { connectorActionToolRef } from "../tool-spec/tool-contracts.js";
import { repairArchitectDesignForSpec } from "./repair-architect.js";

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
    title: "Weekly product sync",
    summary: "Reviewed internal brief summarizing product progress for the engineering team.",
    strategyText: "Research memories, synthesize facts, write a reviewed artifact.",
    inputsRequired: ["sprint_notes"],
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
      },
      {
        id: "newsletter_writer",
        name: "Writer Agent",
        goal: "Produce one complete newsletter draft ready for human review",
        task: "Synthesize research sources into a newsletter with Subject, Preview, and body sections. Cite sources inline.",
        tool: "internal.llm_only",
        artifactRole: "draft_body",
        inputContract: { description: "Research handoff from prior agent", schema: { handoff: { web_research: { sources: "array" } } } },
        outputContract: { description: "Newsletter email copy", schema: { text: "string", subject: "string", preview: "string", body: "string" } },
        doneCriteria: ["Includes a Subject line", "Includes a Preview line", "Includes one complete newsletter body", "No delivery or sending claims"],
        gate: { type: "draft_review", question: "Review this newsletter draft. Approve to continue, or edit to improve it." },
        renderTarget: "canvas.email",
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
    "Every child agent must have exactly ONE tool, a clear goal (success condition), task, inputContract, outputContract, and 1-8 doneCriteria.",
    "=== ARTIFACT ROLES, OUTPUT FORMAT & APPROVAL GATES ===",
    "For EVERY agent, decide:",
    "  1. artifactRole — how this agent contributes to the final loop outcome:",
    '     "source_evidence" — raw research/memory (handoff only, not the final artifact)',
    '     "draft_body" — produces a draft artifact',
    '     "final_preview" — produces a final preview artifact',
    '     "delivery" — executes an approved external-effect tool when the reviewed workflow calls for one',
    "  2. outputContract — exact shape the agent produces (match tool outputSchema for short-circuit tools)",
    "  3. gate — human approval type when the agent pauses:",
    '     missing_input — operator must PASTE text (sprint notes, briefs). Use ONLY for content inputs in inputsRequired.',
    '     memory_confirmation — operator SELECTS which memories to include',
    '     source_confirmation — operator SELECTS web search sources and may ADD custom URLs/titles/snippets',
    '     draft_review — operator REVIEWS a draft in the canvas; can approve as-is or edit to improve',
    '     pre_send — operator CONFIRMS an external side effect when the selected tool contract requires approval',
    "  4. renderTarget — optional specialized renderer/editor for the output (NOT a tool ref):",
    '     "canvas.email" — editable email workspace when the operator should edit the email visually',
    '     "canvas.preview" — read-only rendered email preview when visual review is useful',
    "",
    "GATE RULES BY TOOL TYPE:",
    "  - Choose gates only when human judgment/input is needed for that agent's output.",
    "  - NEVER put pre_send on internal.llm_only, internal.web_search, internal.memory_search, or composio.<toolkit>.search.",
    "  - NEVER create a separate Pre-send Specialist Agent with internal.llm_only. If text review is needed, use draft_review; if external execution is needed, put pre_send on the exact approved external-effect action agent.",
    "  - Search agents may run without a gate, or use source_confirmation when the operator should curate sources before downstream work.",
    "  - Memory agents may run without a gate, or use memory_confirmation when the operator should curate memories.",
    "  - Review/QA agents are valid when they produce useful review output; do not duplicate human approval unless the workflow needs both.",
    "  - internal.llm_only writing email/newsletter/digest may use plain structured output, markdown, canvas.email, or canvas.preview depending on the workflow.",
    "  - External-effect tools must use the approval gate declared by their tool contract.",
    "  - Render recommendations in tool contracts are advisory. Choose renderTarget from workflow output/review needs, or omit it.",
    "",
    "inputsRequired is ONLY for operator-provided CONTENT needed before drafting (e.g. sprint_notes, product_brief).",
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
    input.noSlopSpec
      ? [
          "Approved no-slop spec (behavioral source of truth):",
          input.noSlopSpec.bodyMarkdown,
          "",
          "Normalized no-slop spec JSON:",
          JSON.stringify(input.noSlopSpec.specJson, null, 2),
        ].join("\n")
      : null,
    input.feedback ? `Feedback:\n${input.feedback}` : null,
    `Memories (with ids and scores):\n${input.memories}`,
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
  const design = repairArchitectDesignForSpec(normalizeArchitectOutput({
    ...parsed,
    schedule: {
      cron: normalizeDesignCron(parsed.schedule.cron, input.prompt),
      timezone: parsed.schedule.timezone?.trim() || "UTC",
    },
  }, input.noSlopSpec), input.noSlopSpec);
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

  const [memories, preferences] = await Promise.all([
    recall(prompt, input.auth).catch(() => []),
    listPrefs(input.auth).catch(() => []),
  ]);
  const selectedPreferences = preferences.slice(0, 8).map((p) => ({
    id: p.id,
    text: p.text,
    category: p.category ?? null,
  }));

  const memoryBlock = formatMemoriesForArchitect(memories);
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
      },
    },
    delivery: design.delivery,
    connectorPolicy: input.noSlopSpec?.specJson.connectorPolicy,
    inputsRequired: design.inputsRequired,
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

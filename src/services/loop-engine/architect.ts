/**
 * architect.ts — Preset-free loop design via LLM architect + enforcing critic.
 */

import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
import { getEffectiveLoopConstraints, listLoopTools, validateAgentRoster } from "../loop-executor/tool-catalog.js";
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
  type LoopArchitectOutput,
  type WorkflowCriticResult,
} from "./contracts.js";
import { critiqueLoopDesign } from "./critic.js";
import { formatMemoriesForArchitect, recallForDesigner } from "./recall.js";

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
  priorProposal?: {
    title: string;
    summary: string;
    definition: { agentGraph?: { children: Array<{ id: string; name: string; tools: Array<{ ref: string }> }> } };
    rationale: string[];
  };
  testOverrides?: DesignerTestOverrides;
};

function formatToolCatalog(): string {
  return listLoopTools()
    .map((tool) => `- ${tool.ref}: ${tool.description} (risk: ${tool.riskLevel})`)
    .join("\n");
}

function formatPreferences(preferences: Array<{ id: string; text: string; category?: string | null }>): string {
  if (preferences.length === 0) return "No saved preferences.";
  return preferences.map((p, i) => `${i + 1}. [${p.id}] ${p.text}`).join("\n");
}

function buildArchitectSystemPrompt(): string {
  const outputExample = JSON.stringify({
    title: "Weekly product sync",
    summary: "Reviewed internal brief summarizing product progress for the engineering team.",
    strategyText: "Research memories, synthesize facts, write a reviewed artifact.",
    inputsRequired: ["sprint_notes"],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "memory_search",
        name: "Memory Search Agent",
        goal: "Return at least one memory with id and excerpt attached",
        task: "Search memories for specific past product updates that directly support the requested sync email. Include style signals only if they affect the expected output.",
        tool: "internal.memory_search",
        inputContract: { description: "Focused memory search query derived from the loop goal", schema: { query: "string", expected_output: "string" } },
        outputContract: { description: "Validated task-relevant memories with ids, excerpts, reasons, and confidence", schema: { memories: [{ id: "string", excerpt: "string", reason: "string", confidence: "number" }] } },
        doneCriteria: ["Every memory includes an id", "At least one relevant result or explicit none found"],
        gate: { type: "memory_confirmation", question: "Are these the items you want to cover?" },
      },
      {
        id: "draft_writer",
        name: "Draft Writer",
        goal: "Produce one reviewed email draft",
        task: "Write the final email draft from approved memories and inputs.",
        tool: "internal.llm_only",
        inputContract: { description: "Approved memories and operator inputs", schema: { context: "string" } },
        outputContract: { description: "Email copy with subject and preview", schema: { text: "string" } },
        doneCriteria: ["Includes a Subject line", "Includes one complete draft", "No delivery or sending claims"],
        gate: { type: "draft_review", question: "Review and approve this email draft?" },
        renderTarget: "canvas.email",
      },
    ],
    rationale: ["Minimal roster tailored to producing a reviewed artifact"],
    suggestedChannels: ["primary"],
  }, null, 2);

  return [
    "You are a loop architect for Tallei. Design bespoke recurring agent loops from first principles.",
    "Do NOT copy preset patterns. Do NOT mention template IDs or preset names.",
    "Every child agent must have exactly ONE tool, a clear goal (success condition), task, inputContract, outputContract, and 1-3 doneCriteria.",
    'For email or newsletter writing agents, use renderTarget (NOT a tool, must not appear in tool):',
    '  "canvas.email" — for the draft-writer step that produces an editable email draft',
    '  "canvas.preview" — for a final/preview step after approval, shown as a read-only rendered email',
    'Always use delivery: { "provider": "none", "target": "none" }. Outbound delivery is disabled.',
    "Insert human gates where uncertainty is high:",
    "  memory_confirmation after memory search",
    "  missing_input when required inputs (inputsRequired) are absent",
    "  draft_review before approval",
    "Keep rosters minimal (2-6 agents). End with a reviewed artifact, not a delivery agent.",
    "Copy tool refs exactly from the catalog.",
    "For internal.memory_search configs, write a focused query for the requested output. Do not ask for broad memory categories unless the user explicitly needs them.",
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
}): string {
  const sections = [
    `User intent:\n${input.prompt}`,
    input.feedback ? `Feedback:\n${input.feedback}` : null,
    `Memories (with ids and scores):\n${input.memories}`,
    `Preferences:\n${input.preferences}`,
    `Tool catalog:\n${formatToolCatalog()}`,
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
  chat?: typeof loopBuilderOpenAiChat;
}): Promise<{ design: LoopArchitectOutput; model: string }> {
  const chat = input.chat ?? loopBuilderOpenAiChat;
  const response = await chat({
    responseFormat: "json_object",
    temperature: 0.3,
    maxTokens: 4096,
    messages: [
      { role: "system", content: buildArchitectSystemPrompt() },
      { role: "user", content: buildArchitectUserPrompt(input) },
    ],
  });
  const parsed = loopArchitectOutputSchema.parse(JSON.parse(response.text));
  const design: LoopArchitectOutput = {
    ...parsed,
    schedule: {
      cron: normalizeDesignCron(parsed.schedule.cron, input.prompt),
      timezone: parsed.schedule.timezone?.trim() || "UTC",
    },
  };
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
      chat: input.testOverrides?.chat,
    });
    design = result.design;
    model = result.model;
    critic = critiqueLoopDesign(design);

    architectTrace = loopBuilderTraceStageSchema.parse({
      stage: "loop_architect",
      model,
      input: { attempt, prompt, criticFixes: attempt > 0 ? criticFixes : [] },
      output: {
        agentCount: design.agents.length,
        delivery: design.delivery,
        inputsRequired: design.inputsRequired,
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
        designDiagnostics: { critic, trace, delivery: design.delivery, inputsRequired: design.inputsRequired },
      },
    },
    delivery: design.delivery,
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

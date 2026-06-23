import { z } from "zod";

import type { LoopBuildContract } from "../domain/build-contract.js";
import type { NoSlopSpec } from "../contracts/spec-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { LoopIntentContext } from "../contracts/intent-context.js";
import type { SpecAvailableTool } from "./discovery.service.js";
import {
  catalogInputContract,
  draftOutputContract,
} from "../runtime/agent-contract-catalog.js";
import { selectedArtifactContract } from "../domain/build-contract.js";
import { loopBuilderOpenAiChat } from "../llm/openai-chat.js";
import { reportLoopBuilderProgress } from "../utils/progress.js";

export function specAtomicityIssues(spec: Pick<NoSlopSpec, "agents">): string[] {
  const issues: string[] = [];
  for (const agent of spec.agents) {
    const tools = agent.tools ?? [];
    const hasLlmOnly = tools.includes("internal.llm_only");
    const hasConnectorTool = tools.some((tool) => tool.startsWith("composio."));
    if (hasLlmOnly && hasConnectorTool) {
      issues.push(
        `${agent.name} mixes connector tools with internal.llm_only; split read/action work from synthesis.`,
      );
    }
  }
  return issues;
}

function slugifyAgentId(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || `agent_${index + 1}`;
}

function sequentialHandoffBindings(
  agents: Array<{ name: string }>,
): NoSlopSpec["agents"][number]["handoffBindings"][] {
  return agents.map((agent, index) => {
    if (index === 0) return [];
    const prior = agents[index - 1]!;
    return [{
      source: {
        kind: "agent_output" as const,
        agentId: slugifyAgentId(prior.name, index - 1),
        path: "/",
      },
      targetPath: "/priorOutput",
      required: true,
      provenance: "agent_output" as const,
      transformation: "direct" as const,
    }];
  });
}

const conductorAgentSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  guardrails: z.array(z.string()).default([]),
  doneWhen: z.array(z.string()).default([]),
});

const conductorOutputSchema = z.object({
  agents: z.array(conductorAgentSchema).min(1).max(8),
});

type ConductorBuildInput = {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  availableTools: SpecAvailableTool[];
  intakeToolRefs: string[];
  mutatingToolRefs: string[];
  artifactStructure?: string;
  outputContract: NonNullable<NoSlopSpec["agents"][number]["outputContract"]>;
  renderer: string;
};

export function buildDeterministicConductorAgents(input: ConductorBuildInput): NoSlopSpec["agents"] {
  const artifact = selectedArtifactContract(input.buildContract);
  const hasIntake = input.intakeToolRefs.length > 0;
  const hasMutating = input.mutatingToolRefs.length > 0;

  if (!hasIntake || !hasMutating) {
    return [];
  }

  const draftAgent: NoSlopSpec["agents"][number] = {
    name: "Draft Writer",
    goal: artifact?.structure?.trim()
      ? `Draft and prepare the approved artifact: ${artifact.structure.trim()}`
      : "Draft the deliverable and request approval before mutating connector actions.",
    tools: input.mutatingToolRefs,
    guardrails: [
      "Do not send or mutate externally without operator approval gates.",
      "Use finalizeAgent output that matches the declared output contract.",
    ],
    doneWhen: ["Draft is ready for review or delivery."],
    doneCriteria: ["Output matches the declared contract."],
    failureModes: ["Pause for operator input when required runtime data is missing."],
    inputContract: catalogInputContract("Prior agent output and trigger context."),
    outputContract: input.outputContract,
    handoffBindings: [],
  };

  const readerAgent: NoSlopSpec["agents"][number] = {
    name: "Context Reader",
    goal: "Read context, search history, and collect source facts.",
    tools: input.intakeToolRefs,
    guardrails: [
      "Gather grounded context only; do not draft the final deliverable.",
      "For required operator input, call requestGate with type=input.",
    ],
    doneWhen: ["Ticket context is ready."],
    doneCriteria: ["Grounded context is available for the next agent."],
    failureModes: ["Pause when required connector reads fail."],
    inputContract: catalogInputContract("Trigger payload, stable configuration, and connector reads."),
    outputContract: {
      description: "Grounded context for downstream agents.",
      representation: "json",
      mediaType: "application/json",
      visibility: "operator",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        additionalProperties: true,
      },
    },
    handoffBindings: [],
  };

  const agents = [readerAgent, draftAgent];
  const bindings = sequentialHandoffBindings(agents);
  return agents.map((agent, index) => ({
    ...agent,
    handoffBindings: bindings[index] ?? [],
  }));
}

async function buildLlmConductorAgents(input: ConductorBuildInput): Promise<NoSlopSpec["agents"]> {
  const toolLines = input.availableTools
    .filter((tool) => !tool.toolRef.startsWith("internal.llm_only"))
    .map((tool) => `- ${tool.toolRef}: ${tool.name} — ${tool.description}`)
    .join("\n");

  const response = await loopBuilderOpenAiChat({
    messages: [
      {
        role: "system",
        content: [
          "You decompose loop workflows into sequential specialist agents.",
          "Each agent gets a disjoint tool subset. Never mix composio connector tools with internal.llm_only in the same agent.",
          "Return JSON: { agents: [{ name, goal, tools, guardrails?, doneWhen? }] }.",
          "Use 2-4 agents for typical support/automation loops.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Purpose: ${input.prompt}`,
          input.intentContext?.resolvedIntent ? `Resolved intent: ${input.intentContext.resolvedIntent}` : "",
          `Available tools:\n${toolLines}`,
          input.artifactStructure ? `Artifact: ${input.artifactStructure}` : "",
        ].filter(Boolean).join("\n\n"),
      },
    ],
    responseFormat: "json_object",
    temperature: 0.2,
  });

  const parsed = conductorOutputSchema.parse(JSON.parse(response.text));
  const bindings = sequentialHandoffBindings(parsed.agents);
  const lastIndex = parsed.agents.length - 1;

  return parsed.agents.map((agent, index) => ({
    name: agent.name.trim(),
    goal: agent.goal.trim(),
    tools: agent.tools,
    guardrails: agent.guardrails.length > 0 ? agent.guardrails : [
      "Use finalizeAgent for structured step output.",
    ],
    doneWhen: agent.doneWhen.length > 0 ? agent.doneWhen : [`${agent.name} step is complete.`],
    doneCriteria: agent.doneWhen.length > 0 ? agent.doneWhen : [`${agent.name} step is complete.`],
    failureModes: ["Pause for operator input when required runtime data is missing."],
    inputContract: catalogInputContract(
      index === 0
        ? "Trigger payload, stable configuration, and connector reads."
        : "Prior agent output and trigger context.",
    ),
    outputContract: index === lastIndex
      ? input.outputContract
      : {
          description: `Structured output from ${agent.name}.`,
          representation: "json",
          mediaType: "application/json",
          visibility: "operator",
          schema: { type: "object", additionalProperties: true },
        },
    handoffBindings: bindings[index] ?? [],
  }));
}

export async function buildConductorAgents(input: ConductorBuildInput): Promise<NoSlopSpec["agents"]> {
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Designing specialist agents for your loop…",
    status: "running",
  });

  if (process.env.NODE_ENV === "test") {
    return buildDeterministicConductorAgents(input);
  }

  try {
    const llmAgents = await buildLlmConductorAgents(input);
    const issues = specAtomicityIssues({ agents: llmAgents });
    if (issues.length === 0) return llmAgents;
    reportLoopBuilderProgress({
      stage: "agent_spawn",
      message: `Conductor LLM produced invalid tool mix; using deterministic split (${issues.join("; ")})`,
      status: "running",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportLoopBuilderProgress({
      stage: "agent_spawn",
      message: `Conductor LLM unavailable; using deterministic split (${message})`,
      status: "running",
    });
  }

  const deterministic = buildDeterministicConductorAgents(input);
  return deterministic;
}

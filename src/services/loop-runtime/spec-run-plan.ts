import {
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedOutputReviewGatesMode,
  selectedReviewPolicy,
  type GroundingSourceRef,
  type OutputReviewGatesMode,
  type ReviewPolicyMode,
} from "../loop-engine/build-contract.js";
import type { InputRequirement, InputSurface } from "../loop-engine/input-surfaces.js";
import type { AgentPersona, NoSlopSpecAgent } from "../loop-engine/spec-contracts.js";
import type { ToolContract, ToolRenderTarget } from "../tool-spec/types.js";
import {
  resolveAgentInputContract,
  resolveAgentOutputContract,
} from "./agent-contract-catalog.js";
import {
  discoveredContractsFromDefinition,
  type SpecRunDefinition,
} from "./spec-run-types.js";
import { resolveBuildContract } from "./definition-hydration.js";
import type { DataContract } from "../loop-engine/data-contract.js";
import {
  contractActionSlug,
  isPlanReadTool,
  isPlanWriteTool,
  isSendLikeContract,
  isWriteContract,
} from "../loop-engine/tool-roles.js";

export type RunPlanAgent = {
  id: string;
  index: number;
  nodeKind?: "agent" | "transform" | "operator_input" | "action" | "checkpoint";
  name: string;
  goal: string;
  guardrails: string[];
  doneWhen: string[];
  doneCriteria: string[];
  failureModes: string[];
  toolRefs: string[];
  inputContract: {
    description: string;
    schema: Record<string, unknown>;
  };
  outputContract: DataContract;
  handoffBindings: AgentHandoffBinding[];
  gate?: {
    type: string;
    question: string;
  };
  artifactRole?: "source_evidence" | "draft_body" | "final_preview" | "delivery";
  outputArtifactId: string;
  outputArtifactKind: string;
  persona?: AgentPersona;
};

export type AgentHandoffBinding = {
  source: {
    kind: "agent_output" | "operator_input" | "stable_config" | "artifact";
    agentId?: string;
    key?: string;
    path: string;
  };
  targetPath: string;
  required: boolean;
  valuePolicy?: "derivable" | "passthrough";
  provenance?: "agent_output" | "operator_input" | "stable_config" | "artifact" | "connector_output";
  transformation?: "direct" | "merge" | "transform";
};

export type RunPlanTool = {
  toolKey: string;
  toolRef: string;
  contract: ToolContract;
  toolkit: string;
  actionSlug: string;
  effect: ToolContract["effect"];
  executionMode: ToolContract["executionMode"];
  requiresApproval: boolean;
  isSendLike: boolean;
  renderTargets: ToolRenderTarget[];
};

export type CompiledSpecRunPlan = {
  agents: RunPlanAgent[];
  inputRequirements: InputRequirement[];
  grounding: GroundingSourceRef[];
  externalDataToolkits: string[];
  reviewPolicy: ReviewPolicyMode | null;
  outputReviewGatesMode: OutputReviewGatesMode;
  readTools: RunPlanTool[];
  writeTools: RunPlanTool[];
  reviewSurfaces: InputSurface[];
};

function contractToolkit(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

export function runPlanToolKey(contract: ToolContract): string {
  const toolkit = contractToolkit(contract) || contract.provider;
  const actionSlug = contractActionSlug(contract);
  return `action_${toolkit}_${actionSlug}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

function compileTool(contract: ToolContract): RunPlanTool {
  return {
    toolKey: runPlanToolKey(contract),
    toolRef: contract.toolRef,
    contract,
    toolkit: contractToolkit(contract),
    actionSlug: contractActionSlug(contract),
    effect: contract.effect,
    executionMode: contract.executionMode,
    requiresApproval: contract.approval.required || isWriteContract(contract),
    isSendLike: isSendLikeContract(contract),
    renderTargets: contract.renderRecommendations.map((entry) => entry.target),
  };
}

type PlanAgentSource = SpecRunDefinition["agentGraph"]["children"][number];

function selectedContracts(definition: SpecRunDefinition): ToolContract[] {
  const contract = resolveBuildContract(definition);
  const discovered = discoveredContractsFromDefinition(definition);
  if (!contract) return [];
  const selectedSlugs = new Set(
    selectedConnectorActionSlugs(contract).map((slug) => slug.toUpperCase()),
  );
  if (selectedSlugs.size === 0) return [];
  return discovered.filter((toolContract) => {
    if (toolContract.provider !== "composio") return false;
    return selectedSlugs.has(contractActionSlug(toolContract).toUpperCase());
  });
}

// TODO: move this to a config file
const INTERNAL_TOOL_REFS = new Set([
  "internal.llm_only",
  "internal.memory_search",
  "internal.web_search",
]);

/** Resolve tool refs from the approved spec only — no keyword inference. */
export function declaredAgentToolRefs(
  agent: NoSlopSpecAgent | PlanAgentSource,
  planTools: RunPlanTool[],
): string[] {
  const declared = (agent.tools ?? [])
    .map((tool) => typeof tool === "string" ? tool : tool.ref)
    .map((ref) => ref.trim())
    .filter(Boolean);
  const planRefs = new Set(planTools.map((tool) => tool.toolRef));
  const refs = new Set<string>();

  for (const ref of declared) {
    if (INTERNAL_TOOL_REFS.has(ref) || planRefs.has(ref)) {
      refs.add(ref);
      continue;
    }
    const bySlug = planTools.find((tool) =>
      tool.toolRef === ref
      || tool.actionSlug.toUpperCase() === ref.toUpperCase()
      || tool.toolRef.toUpperCase().endsWith(`.${ref.toUpperCase()}`));
    if (bySlug) refs.add(bySlug.toolRef);
    else refs.add(ref);
  }

  refs.add("internal.llm_only");
  return [...refs];
}

function declaredReviewSurfaces(definition: SpecRunDefinition): InputSurface[] {
  const surfaces = new Set<InputSurface>();
  for (const req of definition.inputRequirements ?? []) {
    if (req.surface.startsWith("review.") || req.surface.startsWith("confirm.")) {
      surfaces.add(req.surface);
    }
  }
  return [...surfaces];
}

function slugArtifactId(agentId: string): string {
  return `${agentId.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40) || "agent"}_output`;
}

function outputArtifactKind(contract: DataContract): string {
  if (contract.renderer === "canvas.preview") return "canvas_preview";
  if (contract.renderer === "canvas.email") return "canvas_email";
  return "structured_output";
}

function defaultInputContract(agent: NoSlopSpecAgent | PlanAgentSource): RunPlanAgent["inputContract"] {
  return {
    description: `Runtime input for ${agent.name}.`,
    schema: { type: "object", properties: {}, additionalProperties: true },
  };
}

function defaultOutputContract(agent: NoSlopSpecAgent | PlanAgentSource): DataContract {
  const fallbackDescription = agent.goal ?? ("task" in agent ? agent.task : agent.name);
  return {
    description: ("doneWhen" in agent ? agent.doneWhen?.[0] : agent.doneCriteria?.[0]) ?? fallbackDescription,
    schema: { type: "object", properties: {}, additionalProperties: true },
    representation: "text",
    mediaType: "text/plain",
  };
}

export function compileSpecRunPlan(definition: SpecRunDefinition): CompiledSpecRunPlan {
  const buildContract = resolveBuildContract(definition);
  const reviewPolicy = buildContract ? selectedReviewPolicy(buildContract) : null;
  const outputReviewGatesMode = buildContract ? selectedOutputReviewGatesMode(buildContract) : "none";
  const contracts = selectedContracts(definition);
  const readTools = contracts
    .filter((contract) => isPlanReadTool(contract, reviewPolicy))
    .map(compileTool);
  const writeTools = contracts
    .filter((contract) => isPlanWriteTool(contract, reviewPolicy))
    .map(compileTool);
  const allTools = [...readTools, ...writeTools];
  const externalDataToolkits = buildContract ? selectedExternalDataToolkits(buildContract) : [];
  const agents = (definition.agentGraph?.children ?? []).map((agent, index): RunPlanAgent => ({
    ...(() => {
      const id = agent.id;
      const outputContract = resolveAgentOutputContract(agent) ?? defaultOutputContract(agent);
      return {
        id,
        index,
        nodeKind: agent.nodeKind,
        name: agent.name,
        goal: agent.goal ?? agent.task,
        guardrails: agent.guardrails ?? [],
        doneWhen: agent.doneCriteria ?? [],
        doneCriteria: agent.doneCriteria ?? [],
        failureModes: agent.failureModes ?? [],
        toolRefs: declaredAgentToolRefs(agent, allTools),
        inputContract: agent.inputContract ?? resolveAgentInputContract(agent),
        outputContract,
        handoffBindings: agent.handoffBindings,
        gate: agent.gate,
        artifactRole: agent.artifactRole,
        outputArtifactId: agent.outputArtifactId ?? slugArtifactId(id),
        outputArtifactKind: agent.outputArtifactKind ?? outputArtifactKind(outputContract),
        persona: agent.persona,
      };
    })(),
  }));

  return {
    agents,
    inputRequirements: definition.inputRequirements ?? [],
    grounding: buildContract ? selectedGroundingSources(buildContract) : [],
    externalDataToolkits,
    reviewPolicy,
    outputReviewGatesMode,
    readTools,
    writeTools,
    reviewSurfaces: declaredReviewSurfaces(definition),
  };
}

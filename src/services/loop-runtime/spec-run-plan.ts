import {
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedReviewPolicy,
  type GroundingSourceRef,
  type ReviewPolicyMode,
} from "../loop-engine/build-contract.js";
import type { InputRequirement, InputSurface } from "../loop-engine/input-surfaces.js";
import type { AgentPersona, NoSlopSpecAgent } from "../loop-engine/spec-contracts.js";
import { slugifyAgentId } from "../loop-builder/agent-personas.js";
import type { ToolContract, ToolRenderTarget } from "../tool-spec/types.js";
import {
  discoveredContractsFromRunnable,
  type RunnableSpec,
} from "./spec-run-types.js";

export type RunPlanAgent = {
  id: string;
  index: number;
  name: string;
  goal: string;
  guardrails: string[];
  doneWhen: string[];
  failureModes: string[];
  toolRefs: string[];
  persona?: AgentPersona;
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

function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name;
}

function isWriteContract(contract: ToolContract): boolean {
  return contract.effect === "write_external" || contract.effect === "irreversible_external";
}

function isSendLikeContract(contract: ToolContract): boolean {
  if (contract.skillTags.includes("send")) return true;
  const text = `${contract.toolRef} ${contract.name} ${contract.description}`.toLowerCase();
  return /\bsend|sent|publish|post\b/.test(text);
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

function selectedContracts(spec: RunnableSpec): ToolContract[] {
  const contract = spec.buildContract ?? spec.noSlopSpec.buildContract ?? spec.noSlopSpec.specJson.buildContract;
  const discovered = discoveredContractsFromRunnable(spec);
  const selectedSlugs = new Set(
    contract ? selectedConnectorActionSlugs(contract).map((slug) => slug.toUpperCase()) : [],
  );
  if (selectedSlugs.size === 0) return discovered;
  return discovered.filter((toolContract) => {
    if (toolContract.provider !== "composio") return true;
    return selectedSlugs.has(contractActionSlug(toolContract).toUpperCase());
  });
}

const INTERNAL_TOOL_REFS = new Set([
  "internal.llm_only",
  "internal.memory_search",
  "internal.web_search",
]);

/** Resolve tool refs from the approved spec only — no keyword inference. */
export function declaredAgentToolRefs(
  agent: NoSlopSpecAgent,
  planTools: RunPlanTool[],
): string[] {
  const declared = (agent.tools ?? []).map((ref) => ref.trim()).filter(Boolean);
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

function inferredReviewSurfaces(spec: RunnableSpec, writeTools: RunPlanTool[]): InputSurface[] {
  const surfaces = new Set<InputSurface>();
  for (const req of spec.noSlopSpec.specJson.inputRequirements) {
    if (req.surface.startsWith("review.") || req.surface.startsWith("confirm.")) {
      surfaces.add(req.surface);
    }
  }
  for (const tool of writeTools) {
    if (tool.renderTargets.includes("canvas.email")) surfaces.add("review.email");
    else if (tool.renderTargets.includes("canvas.preview")) surfaces.add("review.preview");
    else if (tool.requiresApproval) surfaces.add("confirm.send");
  }
  if ((spec.artifacts?.templates.length ?? 0) > 0) surfaces.add("review.email");
  if (spec.artifacts?.structure) surfaces.add("review.draft");
  return [...surfaces];
}

export function compileSpecRunPlan(spec: RunnableSpec): CompiledSpecRunPlan {
  const buildContract = spec.buildContract ?? spec.noSlopSpec.buildContract ?? spec.noSlopSpec.specJson.buildContract;
  const reviewPolicy = buildContract ? selectedReviewPolicy(buildContract) : null;
  const contracts = selectedContracts(spec);
  const readTools = contracts
    .filter((contract) => contract.effect === "read_external")
    .map(compileTool);
  const writeTools = contracts
    .filter((contract) => {
      if (!isWriteContract(contract)) return false;
      if (reviewPolicy === "draft_only" && isSendLikeContract(contract)) return false;
      return true;
    })
    .map(compileTool);
  const allTools = [...readTools, ...writeTools];
  const externalDataToolkits = buildContract ? selectedExternalDataToolkits(buildContract) : [];
  const agents = spec.noSlopSpec.specJson.agents.map((agent, index): RunPlanAgent => ({
    id: slugifyAgentId(agent.name, index),
    index,
    name: agent.name,
    goal: agent.goal,
    guardrails: agent.guardrails,
    doneWhen: agent.doneWhen,
    failureModes: agent.failureModes,
    toolRefs: declaredAgentToolRefs(agent, allTools),
    persona: agent.persona,
  }));

  return {
    agents,
    inputRequirements: spec.noSlopSpec.specJson.inputRequirements,
    grounding: buildContract ? selectedGroundingSources(buildContract) : [],
    externalDataToolkits,
    reviewPolicy,
    readTools,
    writeTools,
    reviewSurfaces: inferredReviewSurfaces(spec, writeTools),
  };
}

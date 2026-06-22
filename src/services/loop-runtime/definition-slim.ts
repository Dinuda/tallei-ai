import {
  isPersistedBuildContract,
  slimBuildContractForPersistence,
  type AnyLoopBuildContract,
  type LoopBuildContract,
} from "../loop-engine/build-contract.js";
import type { LoopDefinition } from "../loop-executor/types.js";
import {
  defaultHandoffBinding,
  expandAgentGraphChild,
  resolveAgentOutputContract,
  ROLE_AGENT_DEFAULTS,
  type AgentContractRole,
} from "./agent-contract-catalog.js";

const DEFAULT_DRAFT_POLICY = {
  requireDraftBeforeExternalAction: true,
  approvalRequiredFor: ["publish", "send", "external_action"],
};

function arraysEqual(left: string[] | undefined, right: string[]): boolean {
  const a = left ?? [];
  if (a.length !== right.length) return false;
  return a.every((entry, index) => entry === right[index]);
}

function isDefaultHandoffBinding(
  binding: LoopDefinition["agentGraph"]["children"][number]["handoffBindings"][number],
): boolean {
  if (binding.targetPath !== "/") return false;
  if (binding.required !== true && binding.required !== undefined) return false;
  if (binding.valuePolicy && binding.valuePolicy !== "derivable") return false;
  if (binding.provenance && binding.provenance !== "agent_output") return false;
  if (binding.transformation && binding.transformation !== "direct") return false;
  if (binding.source.kind !== "agent_output") return false;
  if (!binding.source.agentId) return false;
  if (binding.source.path && binding.source.path !== "/") return false;
  return true;
}

function slimHandoffBinding(
  binding: LoopDefinition["agentGraph"]["children"][number]["handoffBindings"][number],
): LoopDefinition["agentGraph"]["children"][number]["handoffBindings"][number] {
  if (!isDefaultHandoffBinding(binding)) return binding;
  return {
    source: {
      kind: binding.source.kind,
      agentId: binding.source.agentId,
      path: "/",
    },
    targetPath: binding.targetPath,
    required: true,
  };
}

function isGenericInputContract(
  contract: LoopDefinition["agentGraph"]["children"][number]["inputContract"],
): boolean {
  if (!contract) return true;
  const schema = contract.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const properties = (schema as Record<string, unknown>).properties;
  return (schema as Record<string, unknown>).type === "object"
    && (!properties || (typeof properties === "object" && Object.keys(properties).length === 0));
}

function shouldOmitCatalogContracts(
  agent: LoopDefinition["agentGraph"]["children"][number],
): boolean {
  if (!agent.artifactRole) return false;
  const resolvedOutput = resolveAgentOutputContract(agent);
  const outputMatches = !agent.outputContract
    || (resolvedOutput && JSON.stringify(agent.outputContract) === JSON.stringify(resolvedOutput));
  const inputMatches = isGenericInputContract(agent.inputContract);
  return Boolean(outputMatches && inputMatches);
}

function slimAgentChild(
  agent: LoopDefinition["agentGraph"]["children"][number],
): LoopDefinition["agentGraph"]["children"][number] {
  const roleDefaults = agent.artifactRole ? ROLE_AGENT_DEFAULTS[agent.artifactRole as AgentContractRole] : null;
  const slim: LoopDefinition["agentGraph"]["children"][number] = {
    id: agent.id,
    name: agent.name,
    goal: agent.goal,
    tools: agent.tools,
    handoffBindings: (agent.handoffBindings ?? []).map(slimHandoffBinding),
  };

  if (agent.nodeKind) slim.nodeKind = agent.nodeKind;
  if (agent.persona) slim.persona = agent.persona;
  if (agent.gate) slim.gate = agent.gate;
  if (agent.artifactRole) slim.artifactRole = agent.artifactRole;
  if (agent.outputArtifactKind) slim.outputArtifactKind = agent.outputArtifactKind;

  if (roleDefaults && !arraysEqual(agent.guardrails, roleDefaults.guardrails)) {
    slim.guardrails = agent.guardrails ?? [];
  } else if (!roleDefaults && (agent.guardrails?.length ?? 0) > 0) {
    slim.guardrails = agent.guardrails;
  }

  if (roleDefaults && !arraysEqual(agent.doneCriteria, roleDefaults.doneCriteria)) {
    slim.doneCriteria = agent.doneCriteria ?? [];
  } else if (!roleDefaults && (agent.doneCriteria?.length ?? 0) > 0) {
    slim.doneCriteria = agent.doneCriteria;
  }

  if (roleDefaults && !arraysEqual(agent.failureModes, roleDefaults.failureModes)) {
    slim.failureModes = agent.failureModes ?? [];
  } else if (!roleDefaults && (agent.failureModes?.length ?? 0) > 0) {
    slim.failureModes = agent.failureModes;
  }

  if (!shouldOmitCatalogContracts(agent)) {
    if (agent.inputContract) slim.inputContract = agent.inputContract;
    if (agent.outputContract) slim.outputContract = agent.outputContract;
  }

  if ((agent.handoffBindings ?? []).length === 0) {
    slim.handoffBindings = [];
  }

  return slim;
}

export function slimLoopDefinitionForPersistence(definition: LoopDefinition): LoopDefinition {
  const parent = definition.agentGraph.parent;
  const slim = {
    definitionVersion: definition.definitionVersion,
    goal: definition.goal,
    schedule: definition.schedule,
    agentGraph: {
      parent,
      children: definition.agentGraph.children.map(slimAgentChild),
    },
  } as LoopDefinition;

  if (definition.deliveryType) slim.deliveryType = definition.deliveryType;
  if (definition.delivery) slim.delivery = definition.delivery;
  if (definition.connectorPolicy) slim.connectorPolicy = definition.connectorPolicy;
  if (definition.inputRequirements && definition.inputRequirements.length > 0) {
    slim.inputRequirements = definition.inputRequirements;
  }
  if (definition.engineVersion) slim.engineVersion = definition.engineVersion;
  if (definition.builderMeta) slim.builderMeta = definition.builderMeta;

  if (definition.buildContract) {
    slim.buildContract = slimBuildContractForPersistence(definition.buildContract as LoopBuildContract);
  }

  const draftPolicy = definition.draftPolicy ?? DEFAULT_DRAFT_POLICY;
  if (
    draftPolicy.requireDraftBeforeExternalAction !== DEFAULT_DRAFT_POLICY.requireDraftBeforeExternalAction
    || !arraysEqual(draftPolicy.approvalRequiredFor, DEFAULT_DRAFT_POLICY.approvalRequiredFor)
  ) {
    slim.draftPolicy = draftPolicy;
  }

  if (definition.schedulerTarget && definition.schedulerTarget !== "internal") {
    slim.schedulerTarget = definition.schedulerTarget;
  }
  if (definition.allowedIntegrations && definition.allowedIntegrations.length !== 1) {
    slim.allowedIntegrations = definition.allowedIntegrations;
  } else if (definition.allowedIntegrations?.[0] !== "internal") {
    slim.allowedIntegrations = definition.allowedIntegrations;
  }

  return slim;
}

export function expandLoopDefinitionAgents(definition: LoopDefinition): LoopDefinition {
  return {
    ...definition,
    ceo: definition.ceo ?? {
      name: definition.agentGraph.parent.name,
      task: definition.agentGraph.parent.task,
      policy: definition.agentGraph.parent.policy,
    },
    draftPolicy: definition.draftPolicy ?? DEFAULT_DRAFT_POLICY,
    schedulerTarget: definition.schedulerTarget ?? "internal",
    allowedIntegrations: definition.allowedIntegrations ?? ["internal"],
    agentGraph: {
      ...definition.agentGraph,
      children: definition.agentGraph.children.map(expandAgentGraphChild),
    },
  };
}

export function expandLoopDefinitionBuildContract(definition: LoopDefinition): LoopDefinition {
  return definition;
}

export function isSlimBuildContract(contract: AnyLoopBuildContract | null | undefined): boolean {
  if (!contract) return false;
  return isPersistedBuildContract(contract);
}

export function isSlimLoopDefinition(definition: LoopDefinition): boolean {
  if (!definition.ceo) return true;
  if (isSlimBuildContract(definition.buildContract ?? null)) return true;
  return definition.agentGraph.children.some((agent) =>
    Boolean(agent.artifactRole && !agent.outputContract));
}

export function expandSlimLoopDefinition(definition: LoopDefinition): LoopDefinition {
  if (!isSlimLoopDefinition(definition)) {
    return expandLoopDefinitionBuildContract(definition);
  }
  return expandLoopDefinitionAgents(expandLoopDefinitionBuildContract(definition));
}

export function isDefaultHandoffFromAgent(
  bindings: LoopDefinition["agentGraph"]["children"][number]["handoffBindings"],
  priorAgentId: string,
): boolean {
  if (bindings.length !== 1) return false;
  const binding = bindings[0]!;
  const expected = defaultHandoffBinding(priorAgentId);
  return JSON.stringify(slimHandoffBinding(binding)) === JSON.stringify({
    source: { kind: expected.source.kind, agentId: expected.source.agentId },
    targetPath: expected.targetPath,
  });
}

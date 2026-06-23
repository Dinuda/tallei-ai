import {
  selectedArtifactContract,
  selectedConnectorAgentPlan,
  selectedConnectorSelections,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  type LoopBuildContract,
} from "../domain/build-contract.js";
import {
  draftOutputContract,
} from "../runtime/agent-contract-catalog.js";
import { normalizeToolRef } from "../../tool-spec/tool-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { plannerRoleForToolContract, type ConnectorPlannerRole } from "../domain/tool-roles.js";
import type { ConnectorAgentPlan } from "../contracts/connector-setup.js";
import type { PlanContext } from "./types.js";

function selectedContracts(
  buildContract: LoopBuildContract,
  discoveredToolContracts: ToolContract[],
): ToolContract[] {
  const selectedByAction = new Set(
    selectedConnectorSelections(buildContract).flatMap((selection) =>
      selection.actionSlugs.map((actionSlug) => `${selection.toolkit.trim().toLowerCase()}:${actionSlug.trim().toLowerCase()}`),
    ),
  );
  return discoveredToolContracts.filter((contract) => {
    const toolkit = typeof contract.constraints.toolkit === "string" ? contract.constraints.toolkit.trim().toLowerCase() : "";
    const actionSlug = typeof contract.constraints.actionSlug === "string" ? contract.constraints.actionSlug.trim().toLowerCase() : "";
    return selectedByAction.has(`${toolkit}:${actionSlug}`);
  });
}

function connectorPlanOperations(plan: ConnectorAgentPlan | null | undefined): Array<{
  toolRef: string;
  name: string;
  toolkit: string;
  actionSlug: string;
  plannerRole: ConnectorPlannerRole;
}> {
  return (plan?.parentAgents ?? []).flatMap((parent) =>
    parent.subAgents.flatMap((subAgent) =>
      subAgent.operations.map((operation) => ({
        toolRef: operation.toolRef,
        name: operation.name ?? operation.actionSlug,
        toolkit: subAgent.toolkit,
        actionSlug: operation.actionSlug,
        plannerRole: operation.plannerRole,
      })),
    ),
  );
}

export function resolveConnectorToolRefs(buildContract: LoopBuildContract, discoveredToolContracts: ToolContract[] = []): {
  intakeRefs: string[];
  mutateRefs: string[];
} {
  const plan = selectedConnectorAgentPlan(buildContract);
  const intakeRefs: string[] = [];
  const mutateRefs: string[] = [];
  const planOperations = connectorPlanOperations(plan);
  if (planOperations.length > 0) {
    for (const operation of planOperations) {
      const bucket = operation.plannerRole === "read" ? intakeRefs : mutateRefs;
      if (!bucket.some((ref) => normalizeToolRef(ref) === normalizeToolRef(operation.toolRef))) {
        bucket.push(operation.toolRef);
      }
    }
    return { intakeRefs, mutateRefs };
  }

  for (const contract of selectedContracts(buildContract, discoveredToolContracts)) {
    const toolRef = contract.toolRef;
    const bucket = contract.effect === "read_external"
      ? intakeRefs
      : mutateRefs;
    if (!bucket.some((ref) => normalizeToolRef(ref) === normalizeToolRef(toolRef))) {
      bucket.push(toolRef);
    }
  }

  return { intakeRefs, mutateRefs };
}

export function buildPlanContext(input: {
  prompt: string;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Pick<PlanContext,
  "purpose" | "availableTools" | "intakeRefs" | "mutateRefs" | "connectorAgentPlan" | "artifactStructure" | "artifactBundle" | "outputContract"
> {
  const buildContract = input.buildContract;
  const discoveredToolContracts = input.discoveredToolContracts ?? [];
  const selectedConnectorContracts = selectedContracts(buildContract, discoveredToolContracts);
  const { intakeRefs: connectorIntake, mutateRefs: connectorMutate } = resolveConnectorToolRefs(buildContract, discoveredToolContracts);
  const artifact = selectedArtifactContract(buildContract);
  const grounding = selectedGroundingSources(buildContract);
  const externalSearch = selectedExternalDataToolkits(buildContract);
  const plan = selectedConnectorAgentPlan(buildContract);
  const planOperations = connectorPlanOperations(plan);

  const searchRefs: string[] = [];
  if (grounding.some((source) => source.type === "tallei_memory" || source.type === "workspace_memory")) {
    searchRefs.push("internal.memory_search");
  }
  for (const toolkit of externalSearch) {
    const ref = `composio.${toolkit}.search`;
    if (!searchRefs.includes(ref)) searchRefs.push(ref);
  }

  const availableTools = [
    {
      toolRef: "internal.memory_search",
      name: "Memory search",
      effect: "internal" as const,
      description: "Search Tallei and workspace memory for prior context.",
    },
    {
      toolRef: "internal.web_search",
      name: "Web search",
      effect: "internal" as const,
      description: "Search the web for current information.",
    },
    ...planOperations.map((operation) => ({
      toolRef: operation.toolRef,
      name: operation.name,
      effect: operation.plannerRole === "read" ? "read_external" as const : "write_external" as const,
      description: `${operation.toolkit} action ${operation.actionSlug}.`,
      plannerRole: operation.plannerRole,
    })),
    ...(planOperations.length === 0 ? selectedConnectorContracts.map((contract) => ({
      toolRef: contract.toolRef,
      name: contract.name,
      effect: contract.effect,
      description: contract.description,
      plannerRole: plannerRoleForToolContract(contract),
    })) : []),
    ...externalSearch.map((toolkit) => ({
      toolRef: `composio.${toolkit}.search`,
      name: `${toolkit} search`,
      effect: "read_external" as const,
      description: `Search connected ${toolkit} records.`,
    })),
  ];

  const renderer = artifact?.mode === "supplied_template" ? "canvas.email" as const : "canvas.preview" as const;
  const outputContract = artifact
    ? draftOutputContract(renderer)
    : {
        description: "Structured workflow result.",
        representation: "json" as const,
        mediaType: "application/json" as const,
        visibility: "operator" as const,
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            summary: { type: "string" },
          },
          required: ["summary"],
          additionalProperties: true,
        },
      };

  return {
    purpose: input.prompt.trim(),
    availableTools,
    intakeRefs: [...new Set([...connectorIntake, ...searchRefs])],
    mutateRefs: connectorMutate,
    connectorAgentPlan: plan,
    artifactStructure: artifact?.structure,
    artifactBundle: artifact?.templates?.length ? artifact.templates : null,
    outputContract,
  };
}

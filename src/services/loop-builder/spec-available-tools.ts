import {
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  type LoopBuildContract,
} from "../loop-engine/build-contract.js";
import type { NoSlopSpec } from "../loop-engine/spec-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";

export type SpecAvailableTool = {
  toolRef: string;
  name: string;
  effect: ToolContract["effect"] | "internal";
  description: string;
};

function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name;
}

function connectorSelections(buildContract: LoopBuildContract): Array<{ toolkit: string; actionSlugs: string[] }> {
  const requirement = buildContract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const selections = Array.isArray(value.selections) ? value.selections : [];
  return selections.map((selection) => {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    const toolkit = typeof record.toolkit === "string" ? record.toolkit.trim().toLowerCase() : "";
    const actionSlugs = Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String).filter(Boolean) : [];
    return { toolkit, actionSlugs };
  }).filter((entry) => entry.toolkit && entry.actionSlugs.length > 0);
}

export function availableToolsForSpecDraft(
  buildContract: LoopBuildContract,
  discoveredToolContracts: ToolContract[] = [],
): SpecAvailableTool[] {
  const selectedSlugs = new Set(selectedConnectorActionSlugs(buildContract).map((slug) => slug.toUpperCase()));
  const tools: SpecAvailableTool[] = [
    {
      toolRef: "internal.llm_only",
      name: "Reasoning",
      effect: "internal",
      description: "Pure LLM reasoning without external connector calls.",
    },
    {
      toolRef: "internal.memory_search",
      name: "Memory search",
      effect: "internal",
      description: "Search Tallei and workspace memory for prior context.",
    },
    {
      toolRef: "internal.web_search",
      name: "Web search",
      effect: "internal",
      description: "Search the web for current information.",
    },
  ];

  for (const toolkit of selectedExternalDataToolkits(buildContract)) {
    tools.push({
      toolRef: `composio.${toolkit}.search`,
      name: `${toolkit} search`,
      effect: "read_external",
      description: `Search connected ${toolkit} records.`,
    });
  }

  for (const contract of discoveredToolContracts) {
    if (contract.provider === "composio" && selectedSlugs.size > 0) {
      const slug = contractActionSlug(contract).toUpperCase();
      if (!selectedSlugs.has(slug)) continue;
    }
    if (tools.some((entry) => entry.toolRef === contract.toolRef)) continue;
    tools.push({
      toolRef: contract.toolRef,
      name: contract.name,
      effect: contract.effect,
      description: contract.description.slice(0, 240),
    });
  }

  if (discoveredToolContracts.length === 0) {
    for (const selection of connectorSelections(buildContract)) {
      for (const actionSlug of selection.actionSlugs) {
        const toolRef = `composio.${selection.toolkit}.action.${actionSlug}`;
        if (tools.some((entry) => entry.toolRef === toolRef)) continue;
        const isRead = /read|search|list|get|fetch|retrieve/i.test(actionSlug);
        tools.push({
          toolRef,
          name: actionSlug.replace(/_/g, " "),
          effect: isRead ? "read_external" : "write_external",
          description: `Selected ${selection.toolkit} action ${actionSlug}.`,
        });
      }
    }
  }

  return tools;
}

function isMutatingToolRef(ref: string, availableTools: SpecAvailableTool[]): boolean {
  const entry = availableTools.find((tool) => tool.toolRef === ref);
  if (entry) {
    return entry.effect === "write_external" || entry.effect === "irreversible_external";
  }
  return /\.action\./i.test(ref) && !/search|read/i.test(ref);
}

export function agentToolAssignmentIssues(
  spec: NoSlopSpec,
  availableTools: SpecAvailableTool[],
): string[] {
  const issues: string[] = [];
  const availableRefs = new Set(availableTools.map((tool) => tool.toolRef));
  const writeOwners = new Map<string, string>();

  for (const agent of spec.agents) {
    for (const rawRef of agent.tools ?? []) {
      const ref = rawRef.trim();
      if (!ref) continue;
      if (!availableRefs.has(ref)) {
        issues.push(`Agent "${agent.name}" declares unknown tool ref "${ref}". Use only refs from the available tools list.`);
      }
      if (isMutatingToolRef(ref, availableTools)) {
        const owner = writeOwners.get(ref);
        if (owner && owner !== agent.name) {
          issues.push(`Write tool "${ref}" is assigned to both "${owner}" and "${agent.name}". Each write tool must belong to exactly one agent.`);
        } else {
          writeOwners.set(ref, agent.name);
        }
      }
    }
  }

  return issues;
}

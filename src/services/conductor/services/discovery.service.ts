import {
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  type LoopBuildContract,
} from "../domain/build-contract.js";
import type { NoSlopSpec } from "../contracts/spec-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { canonicalToolRef, normalizeToolRef } from "../../tool-spec/tool-contracts.js";

export type SpecAvailableTool = {
  toolRef: string;
  name: string;
  effect: ToolContract["effect"] | "internal";
  description: string;
  plannerRole?: "read" | "draft" | "publish";
};

function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name ?? "action";
}

function contractDisplayName(contract: ToolContract): string {
  if (typeof contract.name === "string" && contract.name.trim()) return contract.name.trim();
  return contractActionSlug(contract).replace(/_/g, " ");
}

function contractDisplayDescription(contract: ToolContract): string {
  if (typeof contract.description === "string" && contract.description.trim()) {
    return contract.description.slice(0, 240);
  }
  const slug = contractActionSlug(contract);
  const toolkit = typeof contract.constraints.toolkit === "string" ? contract.constraints.toolkit : "";
  return toolkit ? `Selected ${toolkit} action ${slug}.` : `Action ${slug}.`;
}

export function availableToolsForCompile(
  buildContract: LoopBuildContract,
  discoveredToolContracts: ToolContract[] = [],
): SpecAvailableTool[] {
  const selectedSlugs = new Set(selectedConnectorActionSlugs(buildContract).map((slug) => slug.toUpperCase()));
  const tools: SpecAvailableTool[] = [
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
      name: contractDisplayName(contract),
      effect: contract.effect,
      description: contractDisplayDescription(contract),
    });
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
  const availableRefs = new Set(availableTools.map((tool) => normalizeToolRef(tool.toolRef)));
  const writeOwners = new Map<string, string>();

  for (const agent of spec.agents) {
    for (const rawRef of agent.tools ?? []) {
      const ref = canonicalToolRef(rawRef.trim());
      if (!ref) continue;
      if (!availableRefs.has(normalizeToolRef(ref))) {
        issues.push(`Agent "${agent.name}" declares unknown tool ref "${ref}". Use only refs from the available tools list.`);
      }
      if (isMutatingToolRef(ref, availableTools)) {
        const ownerKey = normalizeToolRef(ref);
        const owner = writeOwners.get(ownerKey);
        if (owner && owner !== agent.name) {
          issues.push(`Write tool "${ref}" is assigned to both "${owner}" and "${agent.name}". Each write tool must belong to exactly one agent.`);
        } else {
          writeOwners.set(ownerKey, agent.name);
        }
      }
    }
  }

  return issues;
}

function isDeclaredDeliveryToolRef(ref: string, spec: NoSlopSpec): boolean {
  const provider = spec.delivery.provider?.trim();
  if (!provider || provider.toLowerCase() === "none") return false;
  return normalizeToolRef(ref) === normalizeToolRef(provider);
}

export function agentGuardrailToolConflicts(spec: NoSlopSpec): string[] {
  const issues: string[] = [];
  for (const agent of spec.agents) {
    const guardrails = (agent.guardrails ?? []).join(" ").toLowerCase();
    const blocksOutbound = /do not draft or send|do not send outbound|never send/.test(guardrails);
    if (!blocksOutbound) continue;
    for (const ref of agent.tools ?? []) {
      if (isDeclaredDeliveryToolRef(ref.trim(), spec)) {
        issues.push(`Agent "${agent.name}" guardrails forbid outbound actions but includes "${ref}".`);
      }
    }
  }
  return issues;
}

export function validateAgentToolAssignments(
  spec: NoSlopSpec,
  buildContract: LoopBuildContract,
  discoveredToolContracts: ToolContract[] = [],
): string[] {
  const available = availableToolsForCompile(buildContract, discoveredToolContracts);
  return [
    ...agentToolAssignmentIssues(spec, available),
    ...agentGuardrailToolConflicts(spec),
  ];
}

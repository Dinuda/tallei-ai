import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { DiscoveredToolContract } from "../tool-spec/discovery.js";
import type { NoSlopSpec } from "./spec-contracts.js";

type SpecRequiredConnectorAction = {
  toolkit: string;
  actionSlug: string;
  risk: string;
  description?: string;
};

export function normalizeProviderIdentity(value: string): string {
  const parsed = parseConnectorActionToolRef(value);
  const provider = parsed?.toolkit ?? value.replace(/^composio\./i, "").split(".")[0] ?? "";
  return provider.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function actionSlugFromConnectorRef(actionSlug: string): string {
  return actionSlug.replace(/\./g, "_").toUpperCase();
}

/** Derive exact connector actions required by an approved behavioral spec. */
export function deriveRequiredConnectorActionsFromSpec(
  spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">,
): SpecRequiredConnectorAction[] {
  const actions = new Map<string, SpecRequiredConnectorAction>();

  const provider = spec.delivery?.provider?.trim() ?? "";
  if (provider && provider.toLowerCase() !== "none") {
    const parsed = parseConnectorActionToolRef(provider);
    if (parsed) {
      const key = `${parsed.toolkit}:${parsed.actionSlug}`.toLowerCase();
      actions.set(key, {
        toolkit: parsed.toolkit,
        actionSlug: actionSlugFromConnectorRef(parsed.actionSlug),
        risk: "send",
        description: spec.delivery?.description,
      });
    }
    return [...actions.values()];
  }

  return [...actions.values()];
}

export function supplementDiscoveryQueriesFromSpec(
  queries: string[],
  spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">,
): string[] {
  const required = deriveRequiredConnectorActionsFromSpec(spec);
  const provider = spec.delivery?.provider?.trim() ?? "";
  const providerQueries = provider && provider.toLowerCase() !== "none"
    ? queries.map((query) => `${provider} ${query}`.trim())
    : queries;
  const supplements = [
    ...(provider && provider.toLowerCase() !== "none"
      ? [`${provider} ${spec.delivery?.description ?? ""}`.trim()]
      : []),
    ...required.map((action) => `${action.toolkit} ${action.actionSlug.replace(/_/g, " ").toLowerCase()}`),
  ];
  return [...new Set([...supplements, ...providerQueries].map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

function toolkitFromContractRef(toolRef: string): string | null {
  return parseConnectorActionToolRef(toolRef)?.toolkit ?? null;
}

/** Keep spec-required connector contracts and drop unrelated catalogue noise from planner scope. */
export function specSemanticPipeline(
  spec: Pick<NoSlopSpec, "agents">,
): Array<{ name: string; goal: string; downstream: string }> {
  const agents = spec.agents ?? [];
  return agents.map((agent, index) => ({
    name: agent.name,
    goal: agent.goal,
    downstream: index < agents.length - 1
      ? agents[index + 1]!.name
      : "selectedActions",
  }));
}

export function prioritizeDiscoveredConnectors(
  discovered: DiscoveredToolContract[],
  requiredActions: SpecRequiredConnectorAction[],
  preferredProvider?: string,
): DiscoveredToolContract[] {
  const requiredToolkits = new Set(requiredActions.map((action) => action.toolkit.toLowerCase()));
  const preferredIdentity = normalizeProviderIdentity(preferredProvider ?? "");
  const preferredEntries = preferredIdentity
    ? discovered.filter((entry) =>
        normalizeProviderIdentity(toolkitFromContractRef(entry.contract.toolRef) ?? "") === preferredIdentity)
    : [];
  const requiredEntries = requiredToolkits.size === 0 ? discovered : discovered.filter((entry) => {
    if (entry.source === "required_spec") return true;
    const toolkit = toolkitFromContractRef(entry.contract.toolRef);
    return toolkit ? requiredToolkits.has(toolkit.toLowerCase()) : false;
  });
  const candidates = [...new Map(
    [...preferredEntries, ...(requiredEntries.length > 0 ? requiredEntries : discovered)]
      .map((entry) => [entry.contract.toolRef.toLowerCase(), entry]),
  ).values()];
  if (!preferredIdentity) return candidates;
  return [...candidates].sort((left, right) => {
    const leftToolkit = normalizeProviderIdentity(toolkitFromContractRef(left.contract.toolRef) ?? "");
    const rightToolkit = normalizeProviderIdentity(toolkitFromContractRef(right.contract.toolRef) ?? "");
    return Number(rightToolkit === preferredIdentity) - Number(leftToolkit === preferredIdentity);
  });
}

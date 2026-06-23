import type { AuthContext } from "../../../domain/auth/index.js";
import { getCatalogContracts } from "../../connectors/composio-catalog.js";
import type { AnyLoopBuildContract, LoopBuildContract } from "../domain/build-contract.js";
import type { LoopDefinition } from "../workflow/types.js";
import {
  isSlimPersistedToolContract,
  mergePersistedToolContractOverrides,
  normalizeToolRef,
  parseConnectorActionToolRef,
} from "../../tool-spec/tool-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { expandSlimLoopDefinition, isSlimLoopDefinition } from "./definition-slim.js";
import { discoveredContractsFromDefinition } from "./spec-run-types.js";

/** Canonical build contract lives on the persisted loop definition. */
export function resolveBuildContract(definition: LoopDefinition): LoopBuildContract | AnyLoopBuildContract | null {
  return definition.buildContract ?? null;
}

export function resolveDiscoveredToolContracts(definition: LoopDefinition): ToolContract[] {
  return discoveredContractsFromDefinition(definition);
}

export async function hydrateDiscoveredToolContractList(
  contracts: Array<ToolContract | Record<string, unknown>>,
): Promise<ToolContract[]> {
  if (!contracts.length) return [];

  const needsHydration = contracts.some((contract) =>
    isSlimPersistedToolContract(contract as Record<string, unknown>));
  if (!needsHydration) return contracts as ToolContract[];

  const slimRefs: Record<string, unknown>[] = [];
  const fullContracts: ToolContract[] = [];
  const slugs: string[] = [];

  for (const raw of contracts) {
    if (isSlimPersistedToolContract(raw as Record<string, unknown>)) {
      slimRefs.push(raw as Record<string, unknown>);
      const parsed = parseConnectorActionToolRef(String(raw.toolRef ?? ""));
      if (parsed) slugs.push(parsed.actionSlug);
    } else {
      fullContracts.push(raw as ToolContract);
    }
  }

  const catalogContracts = slugs.length > 0 ? await getCatalogContracts({ slugs }) : [];
  const catalogByRef = new Map(catalogContracts.map((contract) => [normalizeToolRef(contract.toolRef), contract]));

  const hydrated: ToolContract[] = [...fullContracts];
  for (const slim of slimRefs) {
    const toolRef = String(slim.toolRef ?? "");
    const catalog = catalogByRef.get(normalizeToolRef(toolRef));
    if (!catalog) {
      throw new Error(`Unable to hydrate slim tool contract from catalog: ${toolRef}`);
    }
    hydrated.push(mergePersistedToolContractOverrides(catalog, slim));
  }

  return hydrated;
}

export async function hydrateDiscoveredToolContracts(definition: LoopDefinition): Promise<LoopDefinition> {
  const contracts = definition.builderMeta?.discoveredToolContracts;
  if (!contracts?.length) return definition;
  if (!contracts.some((contract) => isSlimPersistedToolContract(contract))) return definition;

  const hydrated = await hydrateDiscoveredToolContractList(contracts);
  const builderMeta = definition.builderMeta;
  if (!builderMeta) return definition;

  return {
    ...definition,
    builderMeta: {
      ...builderMeta,
      discoveredToolContracts: hydrated as unknown as Record<string, unknown>[],
    },
  };
}

/** Expand slim persisted shape in-memory and rehydrate Composio tool schemas from local catalog. */
export async function hydrateDefinitionForExecution(
  _auth: AuthContext,
  _workflowId: string,
  definition: LoopDefinition,
): Promise<LoopDefinition> {
  const expanded = isSlimLoopDefinition(definition)
    ? expandSlimLoopDefinition(definition)
    : definition;
  return hydrateDiscoveredToolContracts(expanded);
}

import type { AuthContext } from "../../domain/auth/index.js";
import { connectedAppToolkits, filterComposioToolkitActions, listConnectorAccounts } from "../connectors/composio.js";
import type { NoSlopSpecSnapshot } from "../loop-engine/spec-contracts.js";
import { INTERNAL_TOOL_SPECS } from "./internal-tools.js";
import { generateComposioToolkitSpecs } from "./composio-tools.js";
import { TOOL_USE_CASES } from "./use-cases.js";
import { renderToolSpecMarkdown } from "./render-markdown.js";
import { connectorActionToolRef } from "./tool-contracts.js";
import type { ToolSpecRegistry } from "./types.js";

export type { ToolSpec, ComposioActionSpec, ToolUseCase, ToolSpecRegistry } from "./types.js";
export type { ToolContract, ToolRenderRecommendation } from "./types.js";
export { INTERNAL_TOOL_SPECS, getInternalToolSpec } from "./internal-tools.js";
export { generateComposioToolkitSpec, generateComposioToolkitSpecs, clearComposioToolkitCache } from "./composio-tools.js";
export {
  buildComposioActionContract,
  buildConnectedSearchContract,
  buildPolicyActionContract,
  connectorActionToolRef,
  contractSupportsExternalWrite,
  effectRank,
  getStaticToolContract,
  isRenderTargetCompatible,
  parseConnectorActionToolRef,
} from "./tool-contracts.js";
export { TOOL_USE_CASES, getUseCasesByCategory, getUseCasesByTool } from "./use-cases.js";
export { renderToolSpecMarkdown, renderUseCasesMarkdown } from "./render-markdown.js";

export async function buildToolSpecRegistry(auth: AuthContext): Promise<ToolSpecRegistry> {
  let connectedToolkits: string[] = [];
  try {
    const accounts = await listConnectorAccounts(auth);
    connectedToolkits = connectedAppToolkits(accounts);
  } catch {
    // If connector listing fails, proceed with internal tools only
  }

  const composioToolkits = await generateComposioToolkitSpecs(connectedToolkits);
  const toolContracts = [
    ...INTERNAL_TOOL_SPECS.flatMap((tool) => tool.contract ? [tool.contract] : []),
    ...composioToolkits.flatMap((toolkit) => [
      ...(toolkit.contract ? [toolkit.contract] : []),
      ...(toolkit.actions ?? []).flatMap((action) => action.contract ? [action.contract] : []),
    ]),
  ];

  return {
    internalTools: INTERNAL_TOOL_SPECS,
    composioToolkits,
    toolContracts,
    useCases: TOOL_USE_CASES,
    generatedAt: new Date().toISOString(),
  };
}

function approvedToolRefsForSpec(noSlopSpec: NoSlopSpecSnapshot): Set<string> {
  const policy = noSlopSpec.specJson.connectorPolicy;
  return new Set([
    ...policy.approvedInternalTools.readToolRefs,
    ...policy.approvedInternalTools.writeToolRefs,
    ...policy.approvedComposioToolkits.map((toolkit) => `composio.${toolkit.toLowerCase()}.search`),
    ...policy.allowedReadActions.map((action) => connectorActionToolRef(action)),
    ...policy.allowedWriteActions.map((action) => connectorActionToolRef(action)),
  ].map((ref) => ref.toLowerCase()));
}

/** Limit architect tool reference to spec-approved refs so the LLM cannot pick discovery noise. */
export function filterToolSpecRegistryForSpec(
  registry: ToolSpecRegistry,
  noSlopSpec?: NoSlopSpecSnapshot,
): ToolSpecRegistry {
  if (!noSlopSpec) return registry;

  const allowedRefs = approvedToolRefsForSpec(noSlopSpec);
  const internalTools = registry.internalTools.filter((tool) => allowedRefs.has(tool.ref.toLowerCase()));
  const composioToolkits = registry.composioToolkits
    .map((toolkit) => {
      const searchRef = `composio.${(toolkit.toolkit ?? toolkit.ref.replace(/^composio\./, "")).toLowerCase()}.search`;
      const approvedActions = (toolkit.actions ?? []).filter((action) =>
        action.contract ? allowedRefs.has(action.contract.toolRef.toLowerCase()) : false,
      );
      const includeSearch = allowedRefs.has(searchRef);
      if (!includeSearch && approvedActions.length === 0) return null;
      return {
        ...toolkit,
        actions: approvedActions,
        contract: includeSearch ? toolkit.contract : undefined,
      };
    })
    .filter((toolkit): toolkit is NonNullable<typeof toolkit> => Boolean(toolkit));

  const toolContracts = registry.toolContracts.filter((contract) =>
    allowedRefs.has(contract.toolRef.toLowerCase()),
  );

  return {
    ...registry,
    internalTools,
    composioToolkits,
    toolContracts,
  };
}

export function renderOutcomesForArchitect(registry: ToolSpecRegistry): string {
  return renderToolSpecMarkdown(registry, "outcomes");
}

export function renderToolsForArchitect(registry: ToolSpecRegistry): string {
  return renderToolSpecMarkdown(registry, "tools");
}

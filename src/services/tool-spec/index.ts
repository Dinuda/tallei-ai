import type { AuthContext } from "../../domain/auth/index.js";
import { connectedAppToolkits, listConnectorAccounts } from "../connectors/composio.js";
import type { NoSlopSpecSnapshot } from "../loop-engine/spec-contracts.js";
import { INTERNAL_TOOL_SPECS } from "./internal-tools.js";
import { generateComposioToolkitSpecs } from "./composio-tools.js";
import { TOOL_USE_CASES } from "./use-cases.js";
import { listLearnedUseCases } from "./learned-catalog.js";
import { renderToolSpecMarkdown } from "./render-markdown.js";
import { connectorActionToolRef } from "./tool-contracts.js";
import type { ToolSpecRegistry } from "./types.js";

export type { ToolSpec, ComposioActionSpec, ToolUseCase, ToolSpecRegistry } from "./types.js";
export type { ToolContract, ToolRenderRecommendation } from "./types.js";
export {
  buildConnectorActionReadinessContract,
  containsUnresolvedTemplate,
  validateConnectorReadiness,
  type ConnectorActionReadinessContract,
  type ConnectorSemanticAssertion,
} from "./action-readiness.js";
export { INTERNAL_TOOL_SPECS, getInternalToolSpec } from "./internal-tools.js";
export { generateComposioToolkitSpec, generateComposioToolkitSpecs, clearComposioToolkitCache } from "./composio-tools.js";
export {
  buildComposioActionContract,
  buildConnectedSearchContract,
  connectorActionToolRef,
  contractSupportsExternalWrite,
  effectRank,
  getStaticToolContract,
  hasExactComposioActionSchemas,
  isRenderTargetCompatible,
  parseConnectorActionToolRef,
} from "./tool-contracts.js";
export { TOOL_USE_CASES, getUseCasesByCategory, getUseCasesByTool } from "./use-cases.js";
export { renderToolSpecMarkdown, renderUseCasesMarkdown } from "./render-markdown.js";
export { discoverToolsForIntent, discoverToolsForQueries, mergeRequiredToolContracts, type DiscoveredToolContract } from "./discovery.js";
export { listLearnedToolSpecs, listLearnedUseCases, recordLearnedWorkflow, searchLearnedToolSpecs } from "./learned-catalog.js";

export async function buildToolSpecRegistry(
  auth: AuthContext,
  options: { includeConnectedToolkits?: boolean } = {},
): Promise<ToolSpecRegistry> {
  let connectedToolkits: string[] = [];
  try {
    const accounts = await listConnectorAccounts(auth);
    connectedToolkits = connectedAppToolkits(accounts);
  } catch {
    // If connector listing fails, proceed with internal tools only
  }

  const composioToolkits = options.includeConnectedToolkits === false
    ? []
    : await generateComposioToolkitSpecs(connectedToolkits);
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
    useCases: [...TOOL_USE_CASES, ...await listLearnedUseCases(auth)],
    generatedAt: new Date().toISOString(),
  };
}

export function addDiscoveredContractsToRegistry(
  registry: ToolSpecRegistry,
  contracts: import("./types.js").ToolContract[],
): ToolSpecRegistry {
  const grouped = new Map<string, import("./types.js").ToolContract[]>();
  for (const contract of contracts.filter((entry) => entry.provider === "composio")) {
    const toolkit = String(contract.constraints.toolkit ?? "").toLowerCase();
    if (!toolkit) continue;
    grouped.set(toolkit, [...(grouped.get(toolkit) ?? []), contract]);
  }
  const discoveredToolkits = [...grouped.entries()].map(([toolkit, actions]) => ({
    ref: `composio.${toolkit}`,
    label: toolkit,
    provider: "composio" as const,
    description: `Intent-relevant ${toolkit} actions discovered through Composio.`,
    shortCircuits: false,
    outputDescription: `${toolkit} action result`,
    outputSchema: {
      oneOf: actions.map((action) => action.outputSchema),
    },
    handoffFormat: "Action output is passed to downstream agents.",
    useCases: [],
    limitations: ["Requires the app to be connected before runtime execution."],
    risk: actions.some((action) => action.approval.required) ? "write" as const : "read" as const,
    requiresConnector: true,
    requiresPreSendApproval: actions.some((action) => action.approval.required),
    toolkit,
    actions: actions.map((contract) => ({
      slug: String(contract.constraints.actionSlug ?? contract.toolRef),
      name: contract.name,
      description: contract.description,
      risk: contract.effect === "read_external" ? "read" as const
        : contract.effect === "irreversible_external" ? "destructive" as const : "write" as const,
      inputSchema: contract.inputSchema,
      contract,
    })),
  }));
  const refs = new Set(contracts.map((contract) => contract.toolRef.toLowerCase()));
  return {
    ...registry,
    composioToolkits: [
      ...registry.composioToolkits.filter((toolkit) =>
        !discoveredToolkits.some((entry) => entry.toolkit === toolkit.toolkit)),
      ...discoveredToolkits,
    ],
    toolContracts: [
      ...registry.toolContracts.filter((contract) => !refs.has(contract.toolRef.toLowerCase())),
      ...contracts,
    ],
  };
}

function approvedToolRefsForSpec(noSlopSpec: NoSlopSpecSnapshot): Set<string> {
  const policy = noSlopSpec.specJson.connectorPolicy;
  return new Set([
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

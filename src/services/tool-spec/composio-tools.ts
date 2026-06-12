import { filterComposioToolkitActions, listComposioToolkitTools } from "../connectors/composio.js";
import type { ToolSpec, ComposioActionSpec } from "./types.js";
import { buildComposioActionContract, buildConnectedSearchContract, hasExactComposioActionSchemas } from "./tool-contracts.js";

const composioToolkitCache = new Map<string, { spec: ToolSpec; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function generateComposioToolkitSpec(toolkit: string): Promise<ToolSpec | null> {
  const cached = composioToolkitCache.get(toolkit);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.spec;
  }

  try {
    const actions = filterComposioToolkitActions(await listComposioToolkitTools(toolkit));
    if (actions.length === 0) {
      return null;
    }

    const actionSpecs: ComposioActionSpec[] = actions.filter(hasExactComposioActionSchemas).map((action) => ({
      slug: action.actionSlug,
      name: action.name,
      description: action.description,
      risk: action.risk,
      inputSchema: action.inputSchema,
      contract: buildComposioActionContract(action),
    }));

    const readActions = actionSpecs.filter((a) => a.contract?.effect === "read_external");
    const writeActions = actionSpecs.filter((a) => a.contract?.effect === "write_external");
    const destructiveActions = actionSpecs.filter((a) => a.contract?.effect === "irreversible_external");

    const toolkitLabel = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
    const description = `${toolkitLabel} integration via Composio. Provides ${actionSpecs.length} actions across read (${readActions.length}), external write (${writeActions.length}), and irreversible (${destructiveActions.length}) operations.`;

    const useCases: string[] = [];
    if (readActions.length > 0) {
      useCases.push(`Search and retrieve ${toolkitLabel} data (messages, threads, items)`);
      useCases.push(`List and filter ${toolkitLabel} resources`);
    }
    if (writeActions.length > 0) {
      useCases.push(`Create or update ${toolkitLabel} items`);
      useCases.push(`Modify ${toolkitLabel} resources with approval`);
    }
    if (destructiveActions.length > 0) {
      useCases.push(`Delete or archive ${toolkitLabel} items (requires explicit approval)`);
    }

    const limitations: string[] = [
      `Requires ${toolkitLabel} OAuth connection`,
      "All mutating actions require pre-send approval",
      "Actions are executed deterministically after approval",
    ];
    if (destructiveActions.length > 0) {
      limitations.push("Destructive actions cannot be undone");
    }

    const spec: ToolSpec = {
      ref: `composio.${toolkit}`,
      label: toolkitLabel,
      provider: "composio",
      description,
      shortCircuits: false,
      outputDescription: `Composio action results from ${toolkitLabel} API`,
      outputSchema: { oneOf: actionSpecs.map((action) => action.contract!.outputSchema) },
      handoffFormat: `Output is passed as \`handoff.<agent_id>\` to downstream agents. Results vary by action but typically include \`text\` (formatted summary) and \`data\` (structured results). For search actions, \`data.sources\` contains array of results. For send/write actions, \`data\` contains execution status.`,
      useCases,
      limitations,
      risk: destructiveActions.length > 0 ? "destructive" : writeActions.length > 0 ? "write" : "read",
      requiresConnector: true,
      requiresPreSendApproval: true,
      toolkit,
      actions: actionSpecs,
      contract: buildConnectedSearchContract(toolkit),
    };

    composioToolkitCache.set(toolkit, { spec, cachedAt: Date.now() });
    return spec;
  } catch (error) {
    console.warn(`[tool-spec] failed to generate Composio spec for ${toolkit}:`, error);
    return null;
  }
}

export async function generateComposioToolkitSpecs(toolkits: string[]): Promise<ToolSpec[]> {
  const results = await Promise.allSettled(toolkits.map((t) => generateComposioToolkitSpec(t)));
  return results
    .filter((r): r is PromiseFulfilledResult<ToolSpec | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((spec): spec is ToolSpec => spec !== null);
}

export function clearComposioToolkitCache(): void {
  composioToolkitCache.clear();
}

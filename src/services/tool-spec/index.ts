import type { AuthContext } from "../../domain/auth/index.js";
import { listConnectorAccounts } from "../connectors/composio.js";
import { INTERNAL_TOOL_SPECS } from "./internal-tools.js";
import { generateComposioToolkitSpecs } from "./composio-tools.js";
import { TOOL_USE_CASES } from "./use-cases.js";
import { renderToolSpecMarkdown } from "./render-markdown.js";
import type { ToolSpecRegistry } from "./types.js";

export type { ToolSpec, ComposioActionSpec, ToolUseCase, ToolSpecRegistry } from "./types.js";
export { INTERNAL_TOOL_SPECS, getInternalToolSpec } from "./internal-tools.js";
export { generateComposioToolkitSpec, generateComposioToolkitSpecs, clearComposioToolkitCache } from "./composio-tools.js";
export { TOOL_USE_CASES, getUseCasesByCategory, getUseCasesByTool } from "./use-cases.js";
export { renderToolSpecMarkdown, renderUseCasesMarkdown } from "./render-markdown.js";

export async function buildToolSpecRegistry(auth: AuthContext): Promise<ToolSpecRegistry> {
  let connectedToolkits: string[] = [];
  try {
    const accounts = await listConnectorAccounts(auth);
    connectedToolkits = [...new Set(
      accounts
        .filter((a) => a.status === "connected")
        .map((a) => a.appKey?.trim().toLowerCase())
        .filter((v): v is string => Boolean(v))
    )];
  } catch {
    // If connector listing fails, proceed with internal tools only
  }

  const composioToolkits = await generateComposioToolkitSpecs(connectedToolkits);

  return {
    internalTools: INTERNAL_TOOL_SPECS,
    composioToolkits,
    useCases: TOOL_USE_CASES,
    generatedAt: new Date().toISOString(),
  };
}

export function renderOutcomesForArchitect(registry: ToolSpecRegistry): string {
  return renderToolSpecMarkdown(registry, "outcomes");
}

export function renderToolsForArchitect(registry: ToolSpecRegistry): string {
  return renderToolSpecMarkdown(registry, "tools");
}

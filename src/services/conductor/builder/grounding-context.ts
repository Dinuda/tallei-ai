import type { AuthContext } from "../../../domain/auth/index.js";
import { unresolvedBuildRequirements } from "../domain/build-contract.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";
import { listKnowledgeBindings } from "../../knowledge-base.js";
import { loadWorkflowUserProfile } from "../domain/workflow-user-profile.js";
import { connectedSearchToolkits } from "./connected-search.js";
import type { BuilderAnalyzerPhase } from "./phases/types.js";

export type BuilderGroundingContext = {
  builtinSources: string[];
  recalledPreferences: Array<{ id: string; text: string; category: string | null }>;
  workspaceKnowledgeBases: Array<{ id: string; name: string; kind: string }>;
  connectedSearchToolkits: Array<{ toolkit: string; name: string; connected: boolean }>;
};

/** Shown in discovery/compile when we skip loading memory — hints without DB I/O. */
export const ANALYZER_MEMORY_HINT =
  "If the user references prior preferences, past loops, or workspace facts not in this session, note that the saved loop can search memory at runtime — do not invent recalled facts.";

export function builderGroundingNeeded(
  session: WorkflowBuilderSession,
  phase: BuilderAnalyzerPhase,
): boolean {
  if (phase !== "requirements" || !session.buildContract) return false;
  return unresolvedBuildRequirements(session.buildContract).some((req) => req.kind === "grounding");
}

export async function buildGroundingContext(
  auth: AuthContext,
  session: WorkflowBuilderSession,
): Promise<BuilderGroundingContext> {
  const [bindings, profile] = await Promise.all([
    listKnowledgeBindings(auth).catch(() => null),
    loadWorkflowUserProfile(auth).catch(() => null),
  ]);
  return {
    builtinSources: ["tallei_memory", "workspace_memory"],
    recalledPreferences: (profile?.memories ?? []).map((memory) => ({
      id: memory.id,
      text: memory.text.slice(0, 200),
      category: memory.category ?? null,
    })),
    workspaceKnowledgeBases: (bindings?.knowledgeBases ?? []).map((kb) => ({
      id: kb.id,
      name: kb.name,
      kind: kb.kind,
    })),
    connectedSearchToolkits: connectedSearchToolkits(session.discoveredToolContracts),
  };
}

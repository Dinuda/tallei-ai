import { z } from "zod";
import { tool, type Tool } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import {
  executeApprovedComposioAction,
  runComposioToolkitPrompt,
} from "../connectors/composio.js";
import {
  selectedConnectorAccountId,
  selectedExternalDataToolkits,
  selectedGroundingSources,
} from "../loop-engine/build-contract.js";
import { runGroundedKnowledgeSearch, type GroundingSource } from "../grounded-knowledge-search.js";
import { runExaWebSearch } from "../loop-executor/agent-runner-internals.js";
import { persistLoopRunWorkspaceMemory } from "../workspace-memory.js";
import {
  discoveredContractsFromRunnable,
  type RunnableSpec,
} from "./spec-run-types.js";
import type { ToolContract } from "../tool-spec/types.js";

function contractToolkit(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

function isWriteContract(contract: ToolContract): boolean {
  return contract.effect === "write_external" || contract.effect === "irreversible_external";
}

function isWorkspaceScopedGroundingSource(source: GroundingSource): boolean {
  return source.type === "workspace_memory" || source.type === "knowledge_base" || source.type === "google_doc";
}

function resolveSearchMemorySources(
  sources: GroundingSource[],
  auth: AuthContext,
): { sources: GroundingSource[]; warnings: string[] } {
  const warnings: string[] = [];
  const hasWorkspace = Boolean(auth.workspaceId);
  const filtered = sources.filter((source) => {
    if (!hasWorkspace && isWorkspaceScopedGroundingSource(source)) {
      warnings.push(`${source.type} skipped: no workspace context`);
      return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    return { sources: [{ type: "tallei_memory" }], warnings };
  }
  return { sources: filtered, warnings };
}

export function buildSpecRunTools(input: {
  auth: AuthContext;
  spec: RunnableSpec;
  runId: string;
  workflowId: string;
  workflowTitle: string;
  onFinalize?: (summary: string) => Promise<void>;
}) {
  const buildContract = input.spec.buildContract ?? input.spec.noSlopSpec.buildContract ?? input.spec.noSlopSpec.specJson.buildContract;
  const groundingSources = buildContract ? selectedGroundingSources(buildContract) : [
    { type: "tallei_memory" as const },
    { type: "workspace_memory" as const },
  ];
  const externalToolkits = buildContract ? selectedExternalDataToolkits(buildContract) : [];
  const discovered = discoveredContractsFromRunnable(input.spec);

  const tools: Record<string, Tool> = {};

  tools.searchMemory = tool({
      description: "Search Tallei internal memory and workspace memory (includes prior loop run outputs).",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      execute: async ({ query }) => {
        const requested: GroundingSource[] = groundingSources.length > 0
          ? groundingSources as GroundingSource[]
          : [{ type: "tallei_memory" }, { type: "workspace_memory" }];
        const { sources, warnings } = resolveSearchMemorySources(requested, input.auth);
        const result = await runGroundedKnowledgeSearch({
          auth: input.auth,
          goal: query,
          sources,
          workflowId: input.workflowId,
        });
        return {
          sources: result.sources.map((s) => ({ id: s.id, origin: s.origin, text: s.text.slice(0, 500) })),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      },
  });

  tools.searchWeb = tool({
      description: "Search the public web for current information.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      execute: async ({ query }) => {
        const result = await runExaWebSearch({
          goal: input.spec.goal,
          task: query,
          config: {},
        });
        return { text: result.text, sources: result.sources };
      },
  });

  tools.finalizeRun = tool({
      description: "Mark the loop run complete after all agents and delivery are done. Persists summary to workspace memory.",
      inputSchema: z.object({
        summary: z.string().min(1),
        deliverable: z.string().optional(),
      }),
      execute: async ({ summary, deliverable }) => {
        if (input.auth.workspaceId) {
          await persistLoopRunWorkspaceMemory(input.auth, {
            workflowId: input.workflowId,
            runId: input.runId,
            workflowTitle: input.workflowTitle,
            approvedMemories: [],
            artifactTexts: deliverable ? [deliverable] : [summary],
          });
        }
        await input.onFinalize?.(summary);
        return { ok: true, summary };
      },
  });

  for (const toolkit of externalToolkits) {
    const key = `search_${toolkit.replace(/[^a-z0-9]/gi, "_")}`;
    tools[key] = tool({
      description: `Search connected ${toolkit} for product/user records.`,
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const result = await runComposioToolkitPrompt({
          auth: input.auth,
          toolkit,
          connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, toolkit) : undefined,
          prompt: `${query}\n\nLoop goal: ${input.spec.goal}`,
        });
        return { text: result.text };
      },
    });
  }

  for (const toolContract of discovered) {
    if (toolContract.toolRef.match(/^composio\.[^.]+\.search$/i)) continue;
    if (!isWriteContract(toolContract)) continue;
    const toolkit = contractToolkit(toolContract);
    const actionSlug = String(toolContract.constraints.actionSlug ?? toolContract.name);
    const toolKey = `action_${toolkit}_${actionSlug}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    tools[toolKey] = tool({
      description: `${toolContract.name}: ${toolContract.description}. Requires user approval before execution.`,
      inputSchema: z.object({
        payload: z.record(z.unknown()),
        rationale: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ payload }) => {
        const idempotencyKey = `spec-run:${input.runId}:${toolKey}:${Date.now()}`;
        const result = await executeApprovedComposioAction({
          auth: input.auth,
          toolkit,
          actionSlug,
          connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, toolkit) : undefined,
          payload,
          idempotencyKey,
        });
        if (!result.ok) throw new Error(result.error ?? `Action ${actionSlug} failed`);
        return { ok: true, output: result.output };
      },
    });
  }

  return tools;
}

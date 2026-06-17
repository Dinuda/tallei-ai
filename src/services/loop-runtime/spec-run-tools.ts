import { z } from "zod";
import { tool, type Tool } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import {
  executeApprovedComposioAction,
  runComposioToolkitPrompt,
} from "../connectors/composio.js";
import {
  selectedConnectorAccountId,
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedReviewPolicy,
} from "../loop-engine/build-contract.js";
import { runGroundedKnowledgeSearch, type GroundingSource } from "../grounded-knowledge-search.js";
import { runExaWebSearch } from "../loop-executor/agent-runner-internals.js";
import { noteVectorFailure, persistLoopRunWorkspaceMemory } from "../workspace-memory.js";
import {
  discoveredContractsFromRunnable,
  type RunnableSpec,
} from "./spec-run-types.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { RunContext } from "./build-run-context.js";
import { renderArtifactTemplate } from "./render-artifact-template.js";

function contractToolkit(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

function isWriteContract(contract: ToolContract): boolean {
  return contract.effect === "write_external" || contract.effect === "irreversible_external";
}

function isSendAction(slug: string): boolean {
  const normalized = slug.toUpperCase();
  if (normalized.includes("CREATE") && normalized.includes("DRAFT")) return false;
  return normalized.includes("SEND");
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

function enrichDraftPayload(
  actionSlug: string,
  payload: Record<string, unknown>,
  runContext?: RunContext,
): Record<string, unknown> {
  if (!runContext?.ticket) return payload;
  const slug = actionSlug.toUpperCase();
  if (!slug.includes("CREATE") || !slug.includes("DRAFT")) return payload;

  const template = runContext.templates[0];
  const variables = {
    ticket_subject: runContext.ticket.subject,
    customer_name: runContext.customer?.name ?? runContext.customer?.email ?? "Customer",
  };
  const rendered = template
    ? renderArtifactTemplate(template, variables)
    : null;

  const next = { ...payload };
  if (runContext.customer?.email && !next.recipient_email) {
    next.recipient_email = runContext.customer.email;
  }
  if (runContext.ticket.threadId && !next.thread_id) {
    next.thread_id = runContext.ticket.threadId;
  }
  if (rendered) {
    if (!next.subject) next.subject = rendered.subject;
    if (!next.body) next.body = rendered.body;
    if (!next.is_html) next.is_html = true;
  }
  return next;
}

export function buildSpecRunTools(input: {
  auth: AuthContext;
  spec: RunnableSpec;
  runId: string;
  workflowId: string;
  workflowTitle: string;
  runContext?: RunContext;
  onFinalize?: (summary: string) => Promise<void>;
}) {
  const buildContract = input.spec.buildContract ?? input.spec.noSlopSpec.buildContract ?? input.spec.noSlopSpec.specJson.buildContract;
  const groundingSources = buildContract ? selectedGroundingSources(buildContract) : [
    { type: "tallei_memory" as const },
    { type: "workspace_memory" as const },
  ];
  const externalToolkits = buildContract ? selectedExternalDataToolkits(buildContract) : [];
  const discovered = discoveredContractsFromRunnable(input.spec);
  const allowedSlugs = new Set(
    buildContract
      ? selectedConnectorActionSlugs(buildContract).map((slug) => slug.toUpperCase())
      : discovered.filter(isWriteContract).map((contract) => String(contract.constraints.actionSlug ?? contract.name).toUpperCase()),
  );
  const reviewPolicy = buildContract ? selectedReviewPolicy(buildContract) : "approve_each_action";

  const tools: Record<string, Tool> = {};

  tools.searchMemory = tool({
      description: "Search Tallei internal memory and workspace memory (includes prior loop run outputs). Use for customer history and FAQs — not for discovering new tickets when trigger payload is provided.",
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

  if (input.runContext?.hasTriggerPayload && input.runContext.ticket) {
    tools.getTriggerTicket = tool({
      description: "Return the triggering ticket payload for this event-driven run.",
      inputSchema: z.object({}),
      execute: async () => ({
        ticket: input.runContext!.ticket,
        customer: input.runContext!.customer ?? null,
        trigger: input.runContext!.trigger,
      }),
    });
  }

  tools.finalizeRun = tool({
      description: "Mark the loop run complete after all agents and delivery are done. Persists summary to workspace memory.",
      inputSchema: z.object({
        summary: z.string().min(1),
        deliverable: z.string().optional(),
      }),
      execute: async ({ summary, deliverable }) => {
        await input.onFinalize?.(summary);
        if (input.auth.workspaceId) {
          try {
            await persistLoopRunWorkspaceMemory(input.auth, {
              workflowId: input.workflowId,
              runId: input.runId,
              workflowTitle: input.workflowTitle,
              approvedMemories: [],
              artifactTexts: deliverable ? [deliverable] : [summary],
            });
          } catch (error) {
            noteVectorFailure(error, "loop_run_finalize");
          }
        }
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
    const actionSlug = String(toolContract.constraints.actionSlug ?? toolContract.name);
    const write = isWriteContract(toolContract);

    if (buildContract) {
      if (allowedSlugs.size > 0 && !allowedSlugs.has(actionSlug.toUpperCase())) continue;
    } else if (!write) {
      continue;
    }
    if (reviewPolicy === "draft_only" && write && isSendAction(actionSlug)) {
      continue;
    }

    const toolkit = contractToolkit(toolContract);
    const toolKey = `action_${toolkit}_${actionSlug}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    tools[toolKey] = tool({
      description: `${toolContract.name}: ${toolContract.description}.${write ? " Requires user approval before execution." : ""}`,
      inputSchema: z.object({
        payload: z.record(z.unknown()),
        rationale: z.string().optional(),
      }),
      ...(write ? { needsApproval: true } : {}),
      execute: async ({ payload }) => {
        const enriched = enrichDraftPayload(actionSlug, payload, input.runContext);
        const idempotencyKey = `spec-run:${input.runId}:${toolKey}:${Date.now()}`;
        const result = await executeApprovedComposioAction({
          auth: input.auth,
          toolkit,
          actionSlug,
          connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, toolkit) : undefined,
          payload: enriched,
          idempotencyKey,
        });
        if (!result.ok) throw new Error(result.error ?? `Action ${actionSlug} failed`);
        return { ok: true, output: result.output };
      },
    });
  }

  return tools;
}

import { tool, type Tool } from "ai";
import { z } from "zod";

import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import { executeApprovedComposioAction, runComposioToolkitPrompt } from "../../connectors/composio.js";
import { runGroundedKnowledgeSearch, type GroundingSource } from "../../grounded-knowledge-search.js";
import { selectedConnectorAccountId } from "../domain/build-contract.js";
import { dataInputSurfaceSchema, reviewSurfaceSchema } from "../contracts/input-surfaces.js";
import { runExaWebSearch } from "../workflow/agent-runner-internals.js";
import type { RunContext } from "./build-run-context.js";
import { resolveBuildContract } from "./definition-hydration.js";
import { SpecRunInteractionRequiredError } from "./spec-run-agent-errors.js";
import { emitRunEvent } from "./spec-run-agent-events.js";
import {
  createSpecRunGateInteraction,
  type DeferredWriteToolCall,
} from "./spec-run-interaction-writer.js";
import {
  actionRefsForTool,
  approvalGrantCoversAction,
} from "./spec-run-approval-grants.js";
import type { CompiledSpecRunPlan, RunPlanAgent, RunPlanTool } from "./spec-run-plan.js";
import type { SpecRunDefinition } from "./spec-run-types.js";
import {
  buildConnectorToolInputSchema,
  connectorToolDescription,
  extractConnectorActionPayload,
} from "./connector-tool-input-schema.js";
import { prepareConnectorActionPayload } from "./spec-run-write-payload.js";

type FinalizedAgentToolState = {
  agentOutput?: unknown;
};

export type BuildAgentToolsInput = {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: SpecRunDefinition;
  workflowTitle: string;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  stepAttemptId: string;
  finalized: FinalizedAgentToolState;
  resolvedHandoff?: Record<string, unknown>;
};

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

function groundingSourcesForPlan(plan: CompiledSpecRunPlan): GroundingSource[] {
  if (plan.grounding.length === 0) {
    return [{ type: "tallei_memory" }, { type: "workspace_memory" }];
  }
  return plan.grounding.flatMap((source): GroundingSource[] => {
    if (source.type === "tallei_memory" || source.type === "workspace_memory") return [source];
    if ((source.type === "knowledge_base" || source.type === "google_doc") && source.id) {
      return [{ type: source.type, id: source.id }];
    }
    return [];
  });
}

function selectedWriteTool(plan: CompiledSpecRunPlan, actionRef: string, agent: RunPlanAgent): RunPlanTool | null {
  const normalized = actionRef.trim().toLowerCase();
  const writeTool = plan.writeTools.find((candidate) =>
    candidate.toolKey.toLowerCase() === normalized
    || candidate.toolRef.toLowerCase() === normalized
    || `${candidate.toolkit}.${candidate.actionSlug}`.toLowerCase() === normalized
    || candidate.actionSlug.toLowerCase() === normalized);
  if (!writeTool) return null;
  if (!agent.toolRefs.includes(writeTool.toolRef)) return null;
  return writeTool;
}

function agentWriteTools(plan: CompiledSpecRunPlan, agent: RunPlanAgent): RunPlanTool[] {
  return plan.writeTools.filter((toolRef) => agent.toolRefs.includes(toolRef.toolRef));
}

function agentCanRequestInput(plan: CompiledSpecRunPlan, agent: RunPlanAgent): boolean {
  const gateType = agent.gate?.type.trim().toLowerCase();
  if (gateType === "input") return true;
  return plan.inputRequirements.some((requirement) =>
    requirement.required && requirement.surface.startsWith("input."));
}

function isRedundantTriggerReadTool(runContext: RunContext, readTool: RunPlanTool): boolean {
  if (!runContext.hasTriggerPayload) return false;
  const triggerText = `${runContext.trigger.toolkit ?? ""} ${runContext.trigger.slug ?? ""}`.toLowerCase();
  const isGmailTrigger = triggerText.includes("gmail");
  if (!isGmailTrigger || readTool.toolkit !== "gmail") return false;
  const action = readTool.actionSlug.toUpperCase();
  return action === "GMAIL_LIST_THREADS"
    || action === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"
    || action === "GMAIL_GET_MESSAGE"
    || action === "GMAIL_GET_THREAD";
}

function pauseForInteraction(stepAttemptId: string, interactionId: string): { ok: true; paused: true; interactionId: string } {
  throw new SpecRunInteractionRequiredError(stepAttemptId, interactionId);
}

async function markAgentStepWaiting(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  interactionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [input.stepAttemptId, input.auth.tenantId, input.auth.userId],
  );
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1`,
    [input.runId],
  );
  await emitRunEvent({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    eventType: input.eventType,
    payload: {
      interactionId: input.interactionId,
      ...input.payload,
    },
  });
}

async function withToolEvents<T>(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  toolKey: string;
  input: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  await emitRunEvent({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    eventType: "tool_spawned",
    payload: { toolKey: input.toolKey, input: input.input },
  });
  try {
    const output = await input.execute();
    await emitRunEvent({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: input.stepAttemptId,
      eventType: "tool_completed",
      payload: { toolKey: input.toolKey, output },
    });
    return output;
  } catch (error) {
    await emitRunEvent({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: input.stepAttemptId,
      eventType: "tool_failed",
      payload: { toolKey: input.toolKey, message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export function buildAgentTools(input: BuildAgentToolsInput): Record<string, Tool> {
  const buildContract = resolveBuildContract(input.spec);
  const tools: Record<string, Tool> = {};
  const groundingSources = groundingSourcesForPlan(input.plan);
  const searchCache = new Map<string, unknown>();
  const cachedSearch = async (key: string, execute: () => Promise<unknown>) => {
    const cached = searchCache.get(key);
    if (cached) return { ...(cached as Record<string, unknown>), reused: true };
    const result = await execute();
    searchCache.set(key, result);
    return result;
  };

  tools.getTriggerPayload = tool({
    description: "Return the normalized event trigger payload for this run. Use it as the authoritative input when present.",
    inputSchema: z.object({}),
    execute: async () => withToolEvents({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: input.stepAttemptId,
      toolKey: "getTriggerPayload",
      input: {},
      execute: async () => ({
        trigger: input.runContext.trigger,
        ticket: input.runContext.ticket ?? null,
        customer: input.runContext.customer ?? null,
      }),
    }),
  });

  if (input.agent.toolRefs.includes("internal.memory_search")) {
    tools.searchMemory = tool({
      description: "Search approved internal and workspace grounding sources for context, policy, prior decisions, and FAQs.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => withToolEvents({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: input.stepAttemptId,
        toolKey: "searchMemory",
        input: { query },
        execute: async () => cachedSearch(`memory:${query.trim().toLowerCase()}`, async () => {
          const { sources, warnings } = resolveSearchMemorySources(groundingSources, input.auth);
          const result = await runGroundedKnowledgeSearch({
            auth: input.auth,
            goal: query,
            sources,
            workflowId: input.workflowId,
          });
          return {
            sources: result.sources.map((source) => ({
              id: source.id,
              origin: source.origin,
              title: source.title,
              text: source.text.slice(0, 800),
            })),
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }),
      }),
    });
  }

  if (input.agent.toolRefs.includes("internal.web_search")) {
    tools.searchWeb = tool({
      description: "Search the public web for current information.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => withToolEvents({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: input.stepAttemptId,
        toolKey: "searchWeb",
        input: { query },
        execute: async () => cachedSearch(`web:${query.trim().toLowerCase()}`, async () => {
          const result = await runExaWebSearch({ goal: input.spec.goal, task: query, config: {} });
          return { text: result.text, sources: result.sources };
        }),
      }),
    });
  }

  for (const toolkit of input.plan.externalDataToolkits) {
    const key = `search_${toolkit.replace(/[^a-z0-9]/gi, "_")}`;
    const toolRef = `composio.${toolkit}.search`;
    if (!input.agent.toolRefs.includes(toolRef)) continue;
    tools[key] = tool({
      description: `Search connected ${toolkit} records selected by the build contract.`,
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => withToolEvents({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: input.stepAttemptId,
        toolKey: key,
        input: { query },
        execute: async () => {
          const result = await runComposioToolkitPrompt({
            auth: input.auth,
            toolkit,
            connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, toolkit) : undefined,
            prompt: `${query}\n\nLoop goal: ${input.spec.goal}`,
          });
          return { text: result.text };
        },
      }),
    });
  }

  for (const readTool of input.plan.readTools) {
    if (!input.agent.toolRefs.includes(readTool.toolRef)) continue;
    if (isRedundantTriggerReadTool(input.runContext, readTool)) continue;
    tools[readTool.toolKey] = tool({
      description: connectorToolDescription(readTool.contract),
      inputSchema: buildConnectorToolInputSchema(readTool.contract.inputSchema),
      execute: async (toolInput) => withToolEvents({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: input.stepAttemptId,
        toolKey: readTool.toolKey,
        input: toolInput,
        execute: async () => {
          const payload = extractConnectorActionPayload(toolInput as Record<string, unknown>);
          const prepared = prepareConnectorActionPayload({
            actionSlug: readTool.actionSlug,
            inputSchema: readTool.contract.inputSchema,
            payload,
            runContext: input.runContext,
            resolvedHandoff: input.resolvedHandoff,
          });
          const result = await executeApprovedComposioAction({
            auth: input.auth,
            toolkit: readTool.toolkit,
            actionSlug: readTool.actionSlug,
            connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, readTool.toolkit) : undefined,
            payload: prepared,
            idempotencyKey: `spec-run:${input.runId}:${input.stepAttemptId}:${readTool.toolKey}:${Date.now()}`,
          });
          if (!result.ok) throw new Error(result.error ?? `${readTool.contract.name} failed`);
          return { ok: true, output: result.output };
        },
      }),
    });
  }

  const writeToolsForAgent = agentWriteTools(input.plan, input.agent);
  const canRequestGate = agentCanRequestInput(input.plan, input.agent) || writeToolsForAgent.length > 0;
  if (canRequestGate) {
    const artifactDataSchema = z.union([
      z.record(z.unknown()),
      z.string().transform((raw, ctx) => {
        try { return JSON.parse(raw) as Record<string, unknown>; } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifactData string is not valid JSON" });
          return z.NEVER;
        }
      }),
    ]);
    const requestGateSchema = z.preprocess((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const gate = { ...(raw as Record<string, unknown>) };
      const type = typeof gate.type === "string" ? gate.type.trim().toLowerCase() : gate.type;
      if (type === "review") {
        return {
          ...gate,
          type: "approval",
          approval: {
            surface: gate.surface,
            artifactKey: gate.artifactKey,
            artifactData: gate.artifactData,
            rationale: gate.rationale,
          },
        };
      }
      if (type === "action") {
        return {
          ...gate,
          type: "approval",
          approval: {
            surface: gate.surface,
            artifactKey: gate.artifactKey,
            actionRef: gate.actionRef,
            payload: gate.payload,
            rationale: gate.rationale,
          },
        };
      }
      if (type === "input" && !gate.input) {
        return {
          ...gate,
          input: {
            surface: gate.surface,
            key: gate.key,
            label: gate.label,
            description: gate.description,
          },
        };
      }
      if (type === "approval" && !gate.approval) {
        return {
          ...gate,
          approval: {
            surface: gate.surface,
            artifactKey: gate.artifactKey,
            artifactData: gate.artifactData,
            actionRef: gate.actionRef,
            payload: gate.payload,
            rationale: gate.rationale,
          },
        };
      }
      return gate;
    }, z.object({
      type: z.enum(["input", "approval"]),
      surface: z.string().optional(),
      key: z.string().optional(),
      label: z.string().optional(),
      description: z.string().optional(),
      artifactKey: z.string().optional(),
      artifactData: artifactDataSchema.optional(),
      rationale: z.string().optional(),
      actionRef: z.string().optional(),
      payload: z.record(z.unknown()).optional(),
      input: z.object({
        surface: z.string().optional(),
        key: z.string().optional(),
        label: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      approval: z.object({
        surface: z.string().optional(),
        artifactKey: z.string().optional(),
        artifactData: artifactDataSchema.optional(),
        rationale: z.string().optional(),
        actionRef: z.string().optional(),
        payload: z.record(z.unknown()).optional(),
      }).optional(),
    }).superRefine((value, ctx) => {
      if (value.type === "input") {
        const surface = dataInputSurfaceSchema.safeParse(value.input?.surface);
        if (!surface.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["input", "surface"],
            message: "Input gate requires an input.* surface.",
          });
        }
        if (!value.input?.key) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["input", "key"], message: "Input gate requires key." });
        }
        return;
      }
      const approval = value.approval ?? {};
      if (!approval.actionRef) {
        const surface = reviewSurfaceSchema.safeParse(approval.surface);
        if (!surface.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["approval", "surface"],
            message: "Approval review gate requires a review.* or confirm.send surface.",
          });
        }
        if (!approval.artifactKey) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "artifactKey"], message: "Approval review gate requires artifactKey." });
        }
        if (!approval.artifactData) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "artifactData"], message: "Approval review gate requires artifactData." });
        }
        return;
      }
      if (!approval.payload) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "payload"], message: "Approval action gate requires payload." });
        return;
      }
      const writeTool = selectedWriteTool(input.plan, approval.actionRef, input.agent);
      if (!writeTool) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approval", "actionRef"],
          message: `Action is not allowed for agent ${input.agent.name}: ${approval.actionRef}`,
        });
        return;
      }
      try {
        prepareConnectorActionPayload({
          actionSlug: writeTool.actionSlug,
          inputSchema: writeTool.contract.inputSchema,
          payload: approval.payload,
          runContext: input.runContext,
          resolvedHandoff: input.resolvedHandoff,
        });
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approval", "payload"],
          message: error instanceof Error ? error.message : "Connector payload failed schema validation",
        });
      }
    }));

    tools.requestGate = tool({
      description: [
        "Create one first-class operator gate using the canonical top-level model.",
        "Use type=input with input.surface/key for declared input.* surfaces.",
        "Use type=approval with approval.surface/artifactKey/artifactData for canvas or confirmation review.",
        "Use type=approval with approval.actionRef/payload for mutating connector actions; the action executes server-side only after approval.",
      ].join(" "),
      inputSchema: requestGateSchema,
      execute: async (gateInput) => {
        if (gateInput.type === "input") {
          const surface = dataInputSurfaceSchema.parse(gateInput.input?.surface);
          const key = z.string().min(1).parse(gateInput.input?.key);
          const interactionId = await createSpecRunGateInteraction({
            gateType: "input",
            auth: input.auth,
            runId: input.runId,
            stepAttemptId: input.stepAttemptId,
            agentId: input.agent.id,
            agentName: input.agent.name,
            stepIndex: input.agent.index,
            surface,
            key,
            label: gateInput.input?.label,
            description: gateInput.input?.description,
          });
          await markAgentStepWaiting({
            auth: input.auth,
            runId: input.runId,
            stepAttemptId: input.stepAttemptId,
            interactionId,
            eventType: "interaction_requested",
            payload: { toolKey: "requestGate", gateType: "input", surface, key },
          });
          return pauseForInteraction(input.stepAttemptId, interactionId);
        }

        const approval = gateInput.approval ?? {};
        if (!approval.actionRef) {
          const surface = reviewSurfaceSchema.parse(approval.surface);
          const artifactKey = z.string().min(1).parse(approval.artifactKey);
          const artifactData = z.record(z.unknown()).parse(approval.artifactData);
          const interactionId = await createSpecRunGateInteraction({
            gateType: "review",
            auth: input.auth,
            runId: input.runId,
            stepAttemptId: input.stepAttemptId,
            agentId: input.agent.id,
            agentName: input.agent.name,
            stepIndex: input.agent.index,
            surface,
            artifactKey,
            artifactData,
            rationale: approval.rationale,
          });
          await markAgentStepWaiting({
            auth: input.auth,
            runId: input.runId,
            stepAttemptId: input.stepAttemptId,
            interactionId,
            eventType: "interaction_requested",
            payload: { toolKey: "requestGate", gateType: "review", surface, artifactKey },
          });
          return pauseForInteraction(input.stepAttemptId, interactionId);
        }

        const actionRef = z.string().min(1).parse(approval.actionRef);
        const payload = z.record(z.unknown()).parse(approval.payload);
        const writeTool = selectedWriteTool(input.plan, actionRef, input.agent);
        if (!writeTool) {
          throw new Error(`Action is not allowed for agent ${input.agent.name}: ${actionRef}`);
        }
        const enriched = prepareConnectorActionPayload({
          actionSlug: writeTool.actionSlug,
          inputSchema: writeTool.contract.inputSchema,
          payload,
          runContext: input.runContext,
          resolvedHandoff: input.resolvedHandoff,
        });
        const deferred: DeferredWriteToolCall = {
          toolkit: writeTool.toolkit,
          actionSlug: writeTool.actionSlug,
          actionLabel: writeTool.contract.name,
          isSendAction: writeTool.isSendLike || writeTool.effect === "irreversible_external",
          actionRef: writeTool.toolRef,
          payload: enriched,
          rationale: approval.rationale,
        };
        const approvalGrant = await approvalGrantCoversAction({
          auth: input.auth,
          runId: input.runId,
          stepAttemptId: input.stepAttemptId,
          actionRefs: actionRefsForTool(writeTool),
        });
        if (approvalGrant) {
          return withToolEvents({
            auth: input.auth,
            runId: input.runId,
            stepAttemptId: input.stepAttemptId,
            toolKey: writeTool.toolKey,
            input: {
              actionRef: writeTool.toolRef,
              payload: enriched,
              approvedByInteractionId: approvalGrant.interactionId,
            },
            execute: async () => {
              const result = await executeApprovedComposioAction({
                auth: input.auth,
                toolkit: writeTool.toolkit,
                actionSlug: writeTool.actionSlug,
                connectorAccountId: buildContract ? selectedConnectorAccountId(buildContract, writeTool.toolkit) : undefined,
                payload: enriched,
                idempotencyKey: `spec-run:${input.runId}:${input.stepAttemptId}:${writeTool.toolKey}`,
              });
              if (!result.ok) throw new Error(result.error ?? `${writeTool.contract.name} failed`);
              return {
                ok: true,
                output: result.output,
                approvedByInteractionId: approvalGrant.interactionId,
              };
            },
          });
        }
        const interactionId = await createSpecRunGateInteraction({
          gateType: "action",
          auth: input.auth,
          runId: input.runId,
          stepAttemptId: input.stepAttemptId,
          agentId: input.agent.id,
          agentName: input.agent.name,
          stepIndex: input.agent.index,
          toolKey: writeTool.toolKey,
          deferred,
          artifactKey: approval.artifactKey,
        });
        await markAgentStepWaiting({
          auth: input.auth,
          runId: input.runId,
          stepAttemptId: input.stepAttemptId,
          interactionId,
          eventType: "gate_requested",
          payload: { toolKey: "requestGate", gateType: "approval", actionRef: writeTool.toolRef, artifactKey: approval.artifactKey },
        });
        return pauseForInteraction(input.stepAttemptId, interactionId);
      },
    });
  }

  tools.finalizeAgent = tool({
    description: "Complete only the current agent step with structured output for downstream agents.",
    inputSchema: z.object({
      output: z.unknown(),
    }),
    execute: async ({ output }) => {
      input.finalized.agentOutput = output;
      return { ok: true };
    },
  });

  return tools;
}

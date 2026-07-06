import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import {
  buildPlannerCardForTool,
  fetchConnectorPlaybook,
  PlaybookFetchError,
} from "../integrations/composio/playbook.js";
import { getConnectorProvider } from "../integrations/connectors/index.js";
import {
  rankBindingCandidates,
  resolveExplicitBindingAction,
} from "./binding-discovery.js";
import {
  compiledPlanSchema,
  loopSpecSchema,
  type CompiledPlan,
  type ComposioActionInstruction,
  type LoopSpec,
  type ResolvedTool,
} from "./spec.js";
import {
  getLatestSpecRevision,
  getNextPlanRevision,
  hashPlan,
  saveCompiledPlan,
} from "./store.js";
import { validateAgenticCompileArtifacts } from "./plan-validators.js";
import { resolveEventTriggerLocallyForCompile, validateEventTriggerForCompile } from "./event-trigger.js";
import { capabilityForAction, summarizeInputSchema, toolIdForAction } from "./tool-schema.js";
import {
  attachComposioActionInstructionsToTools,
  validateComposioActionInstructions,
} from "./composio-action-instructions.js";
import { buildComposioToolContract } from "./composio-schema-contract.js";
import { getTriggerFieldNamesForFeasibility } from "../integrations/composio/trigger-known-fields.js";
import { isOutcomeBriefConfirmed } from "./outcome-brief.js";
import { getPendingConnectorOutcomes } from "./task-decomposition.js";
import { approvalTargetsRole } from "./approval-policy.js";
import { buildExecutionStrategy } from "./execution-strategy.js";

const MAX_AUTO_EXPAND_TOOLS = 2;

type ToolCatalogDraft = Omit<ResolvedTool, "plannerCard" | "behaviorInstructions" | "outputSufficiencyPaths"> & {
  plannerCard?: ResolvedTool["plannerCard"];
  behaviorInstructions?: string[];
  outputSufficiencyPaths?: string[];
  bindingRole?: LoopSpec["bindings"][number]["role"];
};

export function isToolApprovalSensitive(
  approval: Pick<LoopSpec["approval"], "sensitiveCapabilities" | "sensitiveRoles">,
  input: {
    capability?: string;
    actionSlug?: string;
    role?: LoopSpec["bindings"][number]["role"];
  },
): boolean {
  return (
    (input.capability ? approval.sensitiveCapabilities.includes(input.capability) : false)
    || (input.actionSlug ? approval.sensitiveCapabilities.includes(input.actionSlug) : false)
    || approvalTargetsRole(approval, input.role)
  );
}

function attachPlaybookToCatalog(
  toolCatalog: ToolCatalogDraft[],
  playbookResult: Awaited<ReturnType<typeof fetchConnectorPlaybook>>,
): void {
  for (let i = 0; i < toolCatalog.length; i++) {
    const tool = toolCatalog[i]!;
    const entry = playbookResult.toolsBySlug.get(tool.actionSlug.toUpperCase());
    toolCatalog[i] = {
      ...tool,
      plannerCard: buildPlannerCardForTool(tool, entry, playbookResult.playbook),
      ...(entry?.outputSchema ? { outputSchema: entry.outputSchema } : {}),
    };
  }
}

async function autoExpandRelatedTools(
  parsed: LoopSpec,
  toolCatalog: ToolCatalogDraft[],
  connectedBySlug: Map<string, { connectedAccountId?: string }>,
  playbookResult: Awaited<ReturnType<typeof fetchConnectorPlaybook>>,
): Promise<void> {
  if (toolCatalog.length === 0) return;

  let autoAdded = 0;
  for (const relatedSlug of playbookResult.relatedSlugs) {
    if (autoAdded >= MAX_AUTO_EXPAND_TOOLS) break;
    const normalized = relatedSlug.toUpperCase();
    if (toolCatalog.some((t) => t.actionSlug.toUpperCase() === normalized)) continue;

    const entry = playbookResult.toolsBySlug.get(normalized);
    if (!entry || Object.keys(entry.inputSchema).length === 0) continue;

    const parent = toolCatalog.find((t) =>
      normalizeToolkitSlug(t.connector) === normalizeToolkitSlug(entry.toolkit),
    ) ?? toolCatalog[0]!;
    const toolkit = connectedBySlug.get(normalizeToolkitSlug(parent.connector));
    if (!toolkit?.connectedAccountId) continue;

    const actionSlug = entry.actionSlug;
    const capability = capabilityForAction(actionSlug);
    const sensitive = isToolApprovalSensitive(parsed.approval, {
      capability,
      actionSlug,
      role: "source",
    });

    toolCatalog.push({
      id: toolIdForAction(actionSlug),
      capability,
      connector: parent.connector,
      actionSlug,
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      plannerCard: buildPlannerCardForTool(
        { actionSlug, capability, inputSchema: entry.inputSchema, outputSchema: entry.outputSchema },
        entry,
        playbookResult.playbook,
      ),
      sensitive,
      credentialRef: toolkit.connectedAccountId,
      bindingRole: "source",
    });
    autoAdded++;
  }
}

export type CompileError = {
  code: string;
  message: string;
  binding?: string;
  toolkit?: string;
  connectUrl?: string;
};



function isExplicitActionSlugFormat(actionSlug: string): boolean {
  const trimmed = actionSlug.trim();
  return trimmed.length > 0 && /^[A-Z][A-Z0-9_]+$/.test(trimmed);
}

function resolveExplicitBindingFromSpec(
  binding: LoopSpec["bindings"][number],
): {
  actionSlug: string;
  inputSchema: Record<string, unknown>;
} | null {
  const explicitSlug = binding.actionSlug?.trim();
  if (!explicitSlug || !isExplicitActionSlugFormat(explicitSlug)) return null;

  return {
    actionSlug: explicitSlug.toUpperCase(),
    inputSchema: { type: "object", properties: {} },
  };
}

function validateCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

export async function compileLoopSpec(
  auth: AuthContext,
  loopId: string,
  spec: LoopSpec,
): Promise<{ plan?: CompiledPlan; errors: CompileError[] }> {
  const errors: CompileError[] = [];
  let parsed: LoopSpec;
  try {
    parsed = loopSpecSchema.parse(spec);
  } catch (error) {
    return {
      errors: [{ code: "INVALID_SPEC", message: error instanceof Error ? error.message : "Invalid spec" }],
    };
  }

  if (parsed.workspaceId !== auth.workspaceId) {
    errors.push({ code: "WORKSPACE_MISMATCH", message: "Spec workspace does not match active workspace" });
  }

  if (!isOutcomeBriefConfirmed(parsed)) {
    errors.push({
      code: "OUTCOME_BRIEF_UNCONFIRMED",
      message: "Confirm the current outcome brief before compiling",
      binding: "intentDiscovery.confirmedBriefHash",
    });
  }

  for (const outcome of getPendingConnectorOutcomes(parsed.taskBlueprint)) {
    errors.push({
      code: "CONNECTOR_CHOICE_REQUIRED",
      message: `Choose a connector for ${outcome.description}`,
      binding: `taskBlueprint.${outcome.id}.selectedConnector`,
    });
  }

  for (const outcome of parsed.taskBlueprint?.outcomes ?? []) {
    if (!outcome.selectedConnector) continue;
    const mismatchedBinding = parsed.bindings.find((binding) =>
      binding.role === outcome.role
      && normalizeToolkitSlug(binding.connector) !== normalizeToolkitSlug(outcome.selectedConnector!),
    );
    if (mismatchedBinding) {
      errors.push({
        code: "CONNECTOR_ROLE_MISMATCH",
        message: `${outcome.description} selected ${outcome.selectedConnector}, but its binding uses ${mismatchedBinding.connector}`,
        binding: mismatchedBinding.capability,
        toolkit: mismatchedBinding.connector,
      });
    }
  }

  if (parsed.trigger.kind === "schedule" && !validateCron(parsed.trigger.cron)) {
    errors.push({ code: "INVALID_CRON", message: `Invalid cron: ${parsed.trigger.cron}` });
  }

  if (parsed.profile === "monitor" && !parsed.monitor?.rule) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Monitor profile requires monitor.rule", binding: "monitor.rule" });
  }

  if (parsed.profile === "sync" && !parsed.sync?.mapping) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Sync profile requires sync.mapping", binding: "sync.mapping" });
  }

  for (const binding of parsed.bindings) {
    if (!binding.actionSlug) continue;
    const conflictingInstruction = parsed.composioActions.find((instruction) =>
      normalizeToolkitSlug(instruction.toolkit) === normalizeToolkitSlug(binding.connector)
      && instruction.label?.trim().toLowerCase() === binding.capability.trim().toLowerCase()
      && instruction.actionSlug.toUpperCase() !== binding.actionSlug!.toUpperCase()
    );
    if (conflictingInstruction) {
      errors.push({
        code: "ACTION_INSTRUCTION_MISMATCH",
        message: `${binding.capability} binds ${binding.actionSlug}, but its Composio instructions target ${conflictingInstruction.actionSlug}`,
        binding: binding.capability,
        toolkit: binding.connector,
      });
    }
  }

  if (parsed.trigger.kind === "event") {
    if (!parsed.trigger.composioSlug.trim()) {
      errors.push({
        code: "MISSING_TRIGGER_SLUG",
        message: "Event triggers require composioSlug from the connector catalogue",
        binding: "trigger.composioSlug",
      });
    } else if (parsed.trigger.source.trim()) {
      const localSlug = resolveEventTriggerLocallyForCompile(
        parsed.trigger.source,
        parsed.trigger.composioSlug,
        parsed.trigger.eventType,
      );
      if (localSlug) {
        parsed = {
          ...parsed,
          trigger: { ...parsed.trigger, composioSlug: localSlug },
        };
      } else {
        try {
          const validated = await validateEventTriggerForCompile(
            parsed.trigger.source,
            parsed.trigger.composioSlug,
          );
          parsed = {
            ...parsed,
            trigger: { ...parsed.trigger, composioSlug: validated },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({
            code: "INVALID_TRIGGER_SLUG",
            message,
            binding: "trigger.composioSlug",
          });
        }
      }
    }
  }

  const toolkits = (await getConnectorProvider().listCatalogWithConnections(auth)).filter((toolkit) => toolkit.connected);
  const connectedBySlug = new Map(toolkits.map((t) => [normalizeToolkitSlug(t.slug), t]));

  const toolCatalog: ToolCatalogDraft[] = [];
  for (const binding of parsed.bindings) {
    const resolvedConnector = await resolveToolkitSlug(binding.connector);
    const toolkit = connectedBySlug.get(normalizeToolkitSlug(resolvedConnector));
    if (!toolkit?.connected || !toolkit.connectedAccountId) {
      errors.push({
        code: "CONNECTOR_NOT_CONNECTED",
        message: `${binding.connector} is not connected in this workspace`,
        binding: binding.capability,
        toolkit: binding.connector,
        connectUrl: `/dashboard/loops/${loopId}/conductor?connect=${encodeURIComponent(binding.connector)}`,
      });
      continue;
    }
    const outcomeDescription = parsed.taskBlueprint?.outcomes.find((outcome) =>
      outcome.role === binding.role && outcome.selectedConnector
        ? normalizeToolkitSlug(outcome.selectedConnector) === normalizeToolkitSlug(binding.connector)
        : outcome.role === binding.role,
    )?.description ?? binding.capability;

    const explicitFromSpec = resolveExplicitBindingFromSpec(binding);
    const explicitResolution = explicitFromSpec
      ? { ok: true as const, action: explicitFromSpec }
      : binding.actionSlug
        ? await resolveExplicitBindingAction(binding.connector, binding.actionSlug)
        : null;
    if (explicitResolution && !explicitResolution.ok) {
      errors.push({
        code: explicitResolution.code,
        message: explicitResolution.code === "ACTION_TOOLKIT_MISMATCH"
          ? `${binding.actionSlug} belongs to ${explicitResolution.actualToolkit ?? "another toolkit"}, not ${binding.connector}`
          : `${binding.actionSlug} was not found for ${binding.connector}`,
        binding: binding.capability,
        toolkit: binding.connector,
      });
      continue;
    }

    let resolved: {
      actionSlug: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      toolkitVersion?: string;
    } | null = explicitResolution?.ok ? explicitResolution.action : null;

    if (!resolved) {
      const candidates = await rankBindingCandidates(binding.connector, outcomeDescription);
      const best = candidates[0];
      if (!best) {
        errors.push({
          code: "UNSUPPORTED_CAPABILITY",
          message: `No Composio action found for "${outcomeDescription}" on ${binding.connector}`,
          binding: binding.capability,
        });
        continue;
      }
      resolved = {
        actionSlug: best.actionSlug,
        inputSchema: best.inputSchema,
      };
    }

    const actionSlug = resolved.actionSlug;
    const catalogCapability = capabilityForAction(actionSlug);
    const sensitive = isToolApprovalSensitive(parsed.approval, {
      capability: catalogCapability,
      actionSlug: binding.capability,
      role: binding.role,
    });

    if (Object.keys(resolved.inputSchema).length === 0 && !binding.actionSlug?.trim()) {
      const required = summarizeInputSchema(resolved.inputSchema).required.join(", ") || "see Composio schema";
      errors.push({
        code: "SCHEMA_MISSING",
        message: `${actionSlug} has no input schema — recompile after Composio schema fetch`,
        binding: actionSlug,
      });
      continue;
    }

    toolCatalog.push({
      id: toolIdForAction(actionSlug),
      capability: catalogCapability,
      connector: binding.connector,
      actionSlug,
      inputSchema: resolved.inputSchema,
      ...(resolved.outputSchema ? { outputSchema: resolved.outputSchema } : {}),
      sensitive,
      credentialRef: toolkit.connectedAccountId,
      bindingRole: binding.role,
      role: binding.role,
      ...(resolved.toolkitVersion ? { toolkitVersion: resolved.toolkitVersion } : {}),
    });
  }

  if (errors.length > 0) return { errors };

  const connectedAccounts: Record<string, string> = {};
  for (const [slug, toolkit] of connectedBySlug) {
    if (toolkit.connectedAccountId) connectedAccounts[slug] = toolkit.connectedAccountId;
  }

  let playbookResult: Awaited<ReturnType<typeof fetchConnectorPlaybook>>;
  try {
    playbookResult = await fetchConnectorPlaybook(auth, {
      intent: parsed.intent,
      bindings: parsed.bindings,
      connectedAccounts,
      boundActionSlugs: toolCatalog.map((t) => t.actionSlug),
    });
  } catch (error) {
    const code = error instanceof PlaybookFetchError ? error.code : "PLAYBOOK_FETCH_FAILED";
    const message = error instanceof Error ? error.message : "Playbook fetch failed";
    return { errors: [{ code, message }] };
  }

  attachPlaybookToCatalog(toolCatalog, playbookResult);
  await autoExpandRelatedTools(parsed, toolCatalog, connectedBySlug, playbookResult);

  const existingInstructions = new Map(
    parsed.composioActions.map((instruction) => [
      `${instruction.toolkit.toLowerCase()}:${instruction.actionSlug.toUpperCase()}`,
      instruction,
    ]),
  );
  const triggerSlug = parsed.trigger.kind === "event" ? parsed.trigger.composioSlug : undefined;
  const triggerFieldNames = triggerSlug ? getTriggerFieldNamesForFeasibility(triggerSlug) : [];
  const composioActions: ComposioActionInstruction[] = [];
  for (let i = 0; i < toolCatalog.length; i += 1) {
    const tool = toolCatalog[i]!;
    const playbookEntry = playbookResult.toolsBySlug.get(tool.actionSlug.toUpperCase());
    const originalInputSchema = playbookEntry?.inputSchema ?? tool.inputSchema;
    const originalOutputSchema = playbookEntry?.outputSchema ?? tool.outputSchema;
    const key = `${tool.connector.toLowerCase()}:${tool.actionSlug.toUpperCase()}`;
    const priorActionOutputs = toolCatalog.slice(0, i).map((prior) => ({
      actionSlug: prior.actionSlug,
      outputSchema: playbookResult.toolsBySlug.get(prior.actionSlug.toUpperCase())?.outputSchema ?? prior.outputSchema,
    }));
    const { contract, composioAction, feasibility } = buildComposioToolContract({
      toolkit: tool.connector,
      actionSlug: tool.actionSlug,
      label: tool.capability,
      description: playbookEntry?.description ?? tool.plannerCard?.summary,
      inputSchema: originalInputSchema,
      outputSchema: originalOutputSchema,
      existingInstruction: existingInstructions.get(key),
      bindingRole: tool.bindingRole,
      feasibilityContext: {
        triggerSlug,
        triggerFieldNames,
        priorActions: priorActionOutputs,
      },
    });
    if (!feasibility.feasible) {
      errors.push({
        code: "INFEASIBLE_ACTION",
        message: feasibility.feasibilityReason
          ?? `${tool.actionSlug} cannot source required fields ${feasibility.unresolvableFields.join(", ")}`,
        binding: `${tool.actionSlug}.${feasibility.unresolvableFields.join(",")}`,
        toolkit: tool.connector,
      });
    }
    composioActions.push({
      ...composioAction,
      requiredFields: feasibility.requiredFields,
      feasible: feasibility.feasible,
    });
    toolCatalog[i] = {
      ...tool,
      inputSchema: contract.originalInputSchema,
      ...(contract.originalOutputSchema ? { outputSchema: contract.originalOutputSchema } : {}),
      originalInputSchema: contract.originalInputSchema,
      ...(contract.originalOutputSchema ? { originalOutputSchema: contract.originalOutputSchema } : {}),
      modifiedInputSchema: contract.modifiedInputSchema,
      behaviorInstructions: contract.behaviorInstructions,
      outputSufficiencyPaths: contract.outputSufficiencyPaths,
    };
  }

  errors.push(...validateComposioActionInstructions({
    tools: toolCatalog.map((tool) => ({
      connector: tool.connector,
      actionSlug: tool.actionSlug,
      inputSchema: tool.inputSchema,
    })),
    instructions: composioActions,
  }));

  errors.push(...validateAgenticCompileArtifacts(parsed.profile, toolCatalog, playbookResult.playbook));
  if (errors.length > 0) return { errors };

  const resolvedCatalog = attachComposioActionInstructionsToTools(
    toolCatalog as ResolvedTool[],
    composioActions,
  );
  const executionStrategy = buildExecutionStrategy(parsed, resolvedCatalog);

  const specRevision = await getLatestSpecRevision(loopId);
  const revision = await getNextPlanRevision(loopId);
  const compiledAt = new Date().toISOString();

  const planBase = {
    id: randomUUID(),
    loopId,
    workspaceId: parsed.workspaceId,
    specRevision,
    revision,
    profile: parsed.profile,
    intent: parsed.intent,
    trigger: parsed.trigger,
    toolCatalog: resolvedCatalog,
    composioActions,
    connectorPlaybook: playbookResult.playbook,
    agent: parsed.agent,
    monitor: parsed.monitor,
    sync: parsed.sync,
    output: parsed.output,
    approval: parsed.approval,
    guardrails: parsed.guardrails,
    executionStrategy,
    compiledAt,
    status: "draft" as const,
  };

  const contentHash = hashPlan({ ...planBase, contentHash: "" } as CompiledPlan);
  const planDraft = compiledPlanSchema.parse({ ...planBase, contentHash });
  const plan = await saveCompiledPlan(auth, loopId, planDraft);
  return { plan, errors: [] };
}

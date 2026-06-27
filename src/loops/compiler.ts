import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import {
  buildPlannerCardForTool,
  fetchConnectorPlaybook,
  isEmailGetActionSlug,
  PlaybookFetchError,
} from "../integrations/composio/playbook.js";
import { listToolkitsForUser } from "../integrations/composio/session.js";
import { resolveBindingAction, alignCapabilityWithAction, looksLikeComposioActionSlug } from "./binding-discovery.js";
import {
  compiledPlanSchema,
  loopSpecSchema,
  type CompiledPlan,
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
import { validateEventTriggerForCompile } from "./event-trigger.js";
import { scoreSchemaFitForCapability, semanticCapabilityForAction, summarizeInputSchema } from "./tool-schema.js";

const MAX_AUTO_EXPAND_TOOLS = 2;

function attachPlaybookToCatalog(
  toolCatalog: Array<Omit<ResolvedTool, "plannerCard"> & { plannerCard?: ResolvedTool["plannerCard"] }>,
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
  toolCatalog: Array<Omit<ResolvedTool, "plannerCard"> & { plannerCard?: ResolvedTool["plannerCard"] }>,
  connectedBySlug: Map<string, { connectedAccountId?: string }>,
  playbookResult: Awaited<ReturnType<typeof fetchConnectorPlaybook>>,
): Promise<void> {
  const hasEmailRead = toolCatalog.some((t) => t.capability === "email.read");
  if (!hasEmailRead) return;

  let autoAdded = 0;
  for (const relatedSlug of playbookResult.relatedSlugs) {
    if (autoAdded >= MAX_AUTO_EXPAND_TOOLS) break;
    if (!isEmailGetActionSlug(relatedSlug)) continue;
    if (toolCatalog.some((t) => t.actionSlug.toUpperCase() === relatedSlug.toUpperCase())) continue;

    const parent = toolCatalog.find((t) => t.capability === "email.read");
    if (!parent) continue;

    const toolkit = connectedBySlug.get(normalizeToolkitSlug(parent.connector));
    if (!toolkit?.connectedAccountId) continue;

    const entry = playbookResult.toolsBySlug.get(relatedSlug.toUpperCase());
    const resolved = await resolveBindingAction(parent.connector, "email.get");
    const actionSlug = resolved?.actionSlug ?? relatedSlug;
    if (toolCatalog.some((t) => t.actionSlug.toUpperCase() === actionSlug.toUpperCase())) continue;

    const inputSchema = entry?.inputSchema ?? resolved?.inputSchema ?? {};
    const capability = semanticCapabilityForAction(actionSlug, inputSchema, "email");
    const sensitive = parsed.approval.sensitiveCapabilities.includes(capability);

    toolCatalog.push({
      id: `tool_${capability.replace(/\./g, "_")}`,
      capability,
      connector: parent.connector,
      actionSlug,
      inputSchema,
      ...(entry?.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      plannerCard: buildPlannerCardForTool(
        { actionSlug, capability, inputSchema, outputSchema: entry?.outputSchema },
        entry,
        playbookResult.playbook,
      ),
      sensitive,
      credentialRef: toolkit.connectedAccountId,
      ...(resolved?.toolkitVersion ? { toolkitVersion: resolved.toolkitVersion } : {}),
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

export { scoreToolForCapability } from "./binding-discovery.js";

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

  if (parsed.trigger.kind === "schedule" && !validateCron(parsed.trigger.cron)) {
    errors.push({ code: "INVALID_CRON", message: `Invalid cron: ${parsed.trigger.cron}` });
  }

  if (parsed.profile === "monitor" && !parsed.monitor?.rule) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Monitor profile requires monitor.rule", binding: "monitor.rule" });
  }

  if (parsed.profile === "sync" && !parsed.sync?.mapping) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Sync profile requires sync.mapping", binding: "sync.mapping" });
  }

  if (parsed.trigger.kind === "event") {
    if (!parsed.trigger.composioSlug.trim()) {
      errors.push({
        code: "MISSING_TRIGGER_SLUG",
        message: "Event triggers require composioSlug from the connector catalogue",
        binding: "trigger.composioSlug",
      });
    } else if (parsed.trigger.source.trim()) {
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

  const { toolkits } = await listToolkitsForUser(auth, { isConnected: true, limit: 50 });
  const connectedBySlug = new Map(toolkits.map((t) => [normalizeToolkitSlug(t.slug), t]));

  type ToolCatalogDraft = Omit<ResolvedTool, "plannerCard"> & { plannerCard?: ResolvedTool["plannerCard"] };
  const toolCatalog: ToolCatalogDraft[] = [];
  for (const binding of parsed.bindings) {
    const resolvedConnector = await resolveToolkitSlug(binding.connector);
    const toolkit = connectedBySlug.get(normalizeToolkitSlug(resolvedConnector));
    if (!toolkit?.connected || !toolkit.connectedAccountId) {
      if (!binding.optional) {
        errors.push({
          code: "CONNECTOR_NOT_CONNECTED",
          message: `${binding.connector} is not connected in this workspace`,
          binding: binding.capability,
          toolkit: binding.connector,
          connectUrl: `/dashboard/loops/${loopId}/conductor?connect=${encodeURIComponent(binding.connector)}`,
        });
      }
      continue;
    }
    const resolved = await resolveBindingAction(binding.connector, binding.capability);
    if (!resolved) {
      errors.push({
        code: "UNSUPPORTED_CAPABILITY",
        message: `${binding.capability} not supported for ${binding.connector}`,
        binding: binding.capability,
      });
      continue;
    }
    let catalogCapability = binding.capability;
    const schemaFit = scoreSchemaFitForCapability(
      catalogCapability,
      resolved.inputSchema,
      resolved.actionSlug,
    );
    if (schemaFit < 0) {
      const domain = looksLikeComposioActionSlug(catalogCapability)
        ? (catalogCapability.split("_")[0]?.toLowerCase() || "tool")
        : (catalogCapability.split(".")[0] || "tool");
      const aligned = alignCapabilityWithAction(
        looksLikeComposioActionSlug(catalogCapability)
          ? semanticCapabilityForAction(resolved.actionSlug, resolved.inputSchema, domain)
          : catalogCapability,
        resolved.actionSlug,
        resolved.inputSchema,
      );
      const retryFit = scoreSchemaFitForCapability(aligned, resolved.inputSchema, resolved.actionSlug);
      if (retryFit < 0) {
        const required = summarizeInputSchema(resolved.inputSchema).required.join(", ") || "specific fields";
        errors.push({
          code: "SCHEMA_MISMATCH",
          message: `${catalogCapability} does not match ${resolved.actionSlug} — use capability ${aligned} (action requires: ${required})`,
          binding: catalogCapability,
        });
        continue;
      }
      catalogCapability = aligned;
    }
    const sensitive = parsed.approval.sensitiveCapabilities.includes(catalogCapability);

    toolCatalog.push({
      id: `tool_${catalogCapability.replace(/\./g, "_")}`,
      capability: catalogCapability,
      connector: binding.connector,
      actionSlug: resolved.actionSlug,
      inputSchema: resolved.inputSchema,
      sensitive,
      credentialRef: toolkit.connectedAccountId,
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

  errors.push(...validateAgenticCompileArtifacts(parsed.profile, toolCatalog, playbookResult.playbook));
  if (errors.length > 0) return { errors };

  const resolvedCatalog = toolCatalog as ResolvedTool[];

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
    connectorPlaybook: playbookResult.playbook,
    agent: parsed.agent,
    monitor: parsed.monitor,
    sync: parsed.sync,
    output: parsed.output,
    approval: parsed.approval,
    guardrails: parsed.guardrails,
    compiledAt,
    status: "draft" as const,
  };

  const contentHash = hashPlan({ ...planBase, contentHash: "" } as CompiledPlan);
  const planDraft = compiledPlanSchema.parse({ ...planBase, contentHash });
  const plan = await saveCompiledPlan(auth, loopId, planDraft);
  return { plan, errors: [] };
}

import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
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
import { scoreSchemaFitForCapability, semanticCapabilityForAction, summarizeInputSchema } from "./tool-schema.js";

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
    }
  }

  const { toolkits } = await listToolkitsForUser(auth, { isConnected: true, limit: 50 });
  const connectedBySlug = new Map(toolkits.map((t) => [normalizeToolkitSlug(t.slug), t]));

  const toolCatalog: ResolvedTool[] = [];
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
    toolCatalog,
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

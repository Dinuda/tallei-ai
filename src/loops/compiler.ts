import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { getAllTools, searchTools } from "../integrations/composio/tools.js";
import { listToolkitsForUser } from "../integrations/composio/session.js";
import {
  compiledPlanSchema,
  DEFAULT_SENSITIVE_CAPABILITIES,
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

export type CompileError = {
  code: string;
  message: string;
  binding?: string;
  toolkit?: string;
  connectUrl?: string;
};

const CAPABILITY_ACTION_MAP: Record<string, Record<string, string>> = {
  gmail: {
    "email.read": "GMAIL_FETCH_EMAILS",
    "email.send": "GMAIL_SEND_EMAIL",
  },
  outlook: {
    "email.read": "OUTLOOK_LIST_MESSAGES",
    "email.send": "OUTLOOK_SEND_EMAIL",
  },
  slack: {
    "chat.send": "SLACK_SEND_MESSAGE",
  },
  composio: {
    "web.search": "COMPOSIO_SEARCH_WEB",
  },
  hubspot: {
    "crm.contact.read": "HUBSPOT_GET_CONTACT",
    "crm.contact.write": "HUBSPOT_CREATE_CONTACT",
  },
  zendesk: {
    "support.reply.send": "ZENDESK_CREATE_TICKET_REPLY",
  },
  notion: {
    "docs.read": "NOTION_FETCH_PAGE",
    "docs.write": "NOTION_CREATE_PAGE",
  },
  airtable: {
    "crm.contact.read": "AIRTABLE_LIST_RECORDS",
    "crm.contact.write": "AIRTABLE_CREATE_RECORD",
  },
};

const CAPABILITY_SEARCH_HINTS: Record<string, string> = {
  "email.read": "fetch read emails messages",
  "email.send": "send email message",
  "chat.send": "send message chat",
  "web.search": "search web",
  "crm.contact.read": "list get contacts",
  "crm.contact.write": "create update contact",
  "support.reply.send": "reply ticket support",
  "docs.read": "fetch read page document",
  "docs.write": "create write page document",
};

function resolveStaticActionSlug(connector: string, capability: string): string | null {
  const toolkit = CAPABILITY_ACTION_MAP[connector.toLowerCase()];
  if (!toolkit) return null;
  return toolkit[capability] ?? null;
}

function scoreToolForCapability(
  capability: string,
  actionSlug: string,
  name: string,
  description: string,
): number {
  const capTokens = capability.split(/[._]/).filter(Boolean);
  const haystack = `${actionSlug} ${name} ${description}`.toLowerCase();
  return capTokens.reduce((score, token) => (haystack.includes(token) ? score + 1 : score), 0);
}

export async function resolveBindingAction(
  connector: string,
  capability: string,
): Promise<{ actionSlug: string; inputSchema: Record<string, unknown>; toolkitVersion?: string } | null> {
  const staticSlug = resolveStaticActionSlug(connector, capability);
  if (staticSlug) {
    const tools = await getAllTools(connector);
    const match = tools.find((tool) => tool.actionSlug.toUpperCase() === staticSlug.toUpperCase());
    return {
      actionSlug: staticSlug,
      inputSchema: match?.inputSchema ?? {},
      ...(match?.toolkitVersion ? { toolkitVersion: match.toolkitVersion } : {}),
    };
  }

  const hint = CAPABILITY_SEARCH_HINTS[capability] ?? capability.replace(/\./g, " ");
  const searchQuery = `${connector} ${hint}`.trim();
  const searchResults = await searchTools(searchQuery, 24);
  const normalizedConnector = connector.toLowerCase();
  const searchMatch = searchResults.find((r) => r.toolkit.toLowerCase() === normalizedConnector);
  if (searchMatch) {
    return {
      actionSlug: searchMatch.actionSlug,
      inputSchema: searchMatch.inputSchema ?? {},
      ...(searchMatch.toolkitVersion ? { toolkitVersion: searchMatch.toolkitVersion } : {}),
    };
  }

  const toolkitTools = await getAllTools(connector);
  let best: {
    actionSlug: string;
    inputSchema: Record<string, unknown>;
    toolkitVersion?: string;
    score: number;
  } | null = null;
  for (const tool of toolkitTools) {
    const score = scoreToolForCapability(capability, tool.actionSlug, tool.name, tool.description);
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = {
        actionSlug: tool.actionSlug,
        inputSchema: tool.inputSchema ?? {},
        ...(tool.toolkitVersion ? { toolkitVersion: tool.toolkitVersion } : {}),
        score,
      };
    }
  }
  if (best) {
    return {
      actionSlug: best.actionSlug,
      inputSchema: best.inputSchema,
      ...(best.toolkitVersion ? { toolkitVersion: best.toolkitVersion } : {}),
    };
  }

  return null;
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

  if (parsed.trigger.kind === "schedule" && !validateCron(parsed.trigger.cron)) {
    errors.push({ code: "INVALID_CRON", message: `Invalid cron: ${parsed.trigger.cron}` });
  }

  if (parsed.profile === "monitor" && !parsed.monitor?.rule) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Monitor profile requires monitor.rule", binding: "monitor.rule" });
  }

  if (parsed.profile === "sync" && !parsed.sync?.mapping) {
    errors.push({ code: "INCOMPLETE_SPEC", message: "Sync profile requires sync.mapping", binding: "sync.mapping" });
  }

  const { toolkits } = await listToolkitsForUser(auth, { isConnected: true, limit: 50 });
  const connectedBySlug = new Map(toolkits.map((t) => [t.slug.toLowerCase(), t]));

  const toolCatalog: ResolvedTool[] = [];
  for (const binding of parsed.bindings) {
    const toolkit = connectedBySlug.get(binding.connector.toLowerCase());
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
    const sensitive = (
      parsed.approval.sensitiveCapabilities.length > 0
        ? parsed.approval.sensitiveCapabilities
        : [...DEFAULT_SENSITIVE_CAPABILITIES]
    ).includes(binding.capability);

    toolCatalog.push({
      id: `tool_${binding.capability.replace(/\./g, "_")}`,
      capability: binding.capability,
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

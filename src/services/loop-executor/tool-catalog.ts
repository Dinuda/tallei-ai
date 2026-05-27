import type { AuthContext } from "../../domain/auth/index.js";
import { listConnectorAccounts } from "../workflow-automation.js";
import type { LoopDefinition, LoopToolAssignment } from "./types.js";

export interface LoopCatalogToolView {
  ref: string;
  label: string;
  description: string;
  provider: "internal" | "composio";
  toolkit: string | null;
  requiresConnector: boolean;
  requiresApproval: boolean;
}

export interface LoopToolValidationIssue {
  ref: string;
  code: "unknown_tool" | "tool_not_allowed" | "connector_missing";
  message: string;
}

export interface LoopToolBindContext {
  auth: AuthContext;
  goal: string;
  agentName: string;
  agentTask: string;
  priorComments: Array<{ author: string; body: string }>;
  draftPolicy: LoopDefinition["draftPolicy"];
}

interface LoopCatalogEntry extends LoopCatalogToolView {
  integrationKey: string;
  composioAction?: string;
  isActionable: boolean;
}

const CATALOG: LoopCatalogEntry[] = [
  {
    ref: "internal.llm_only",
    label: "LLM only",
    description: "Pure language-model completion with no external tools.",
    provider: "internal",
    toolkit: null,
    requiresConnector: false,
    requiresApproval: false,
    integrationKey: "internal",
    isActionable: false,
  },
  {
    ref: "internal.memory_search",
    label: "Memory search",
    description: "Search saved Tallei memories for relevant context.",
    provider: "internal",
    toolkit: null,
    requiresConnector: false,
    requiresApproval: false,
    integrationKey: "internal",
    isActionable: true,
  },
  {
    ref: "composio.gmail.create_draft",
    label: "Gmail draft",
    description: "Prepare a Gmail draft for human approval before sending.",
    provider: "composio",
    toolkit: "gmail",
    requiresConnector: true,
    requiresApproval: true,
    integrationKey: "composio",
    composioAction: "GMAIL_CREATE_EMAIL_DRAFT",
    isActionable: true,
  },
  {
    ref: "composio.gmail.send_email",
    label: "Gmail send",
    description: "Send email via Gmail after final run approval.",
    provider: "composio",
    toolkit: "gmail",
    requiresConnector: true,
    requiresApproval: true,
    integrationKey: "composio",
    composioAction: "GMAIL_SEND_EMAIL",
    isActionable: true,
  },
];

const CATALOG_BY_REF = new Map(CATALOG.map((entry) => [entry.ref, entry]));

export function listLoopTools(): LoopCatalogToolView[] {
  return CATALOG.map(({ integrationKey: _i, composioAction: _a, isActionable: _x, ...view }) => view);
}

function goalImpliesExternalDelivery(goal: string): boolean {
  return /newsletter|weekly update|product update|publish|publicist|email|gmail|send|deliver/i.test(goal);
}

/** Effective constraints for validation/prompting — repairs overly narrow create-time caps. */
export function getEffectiveLoopConstraints(
  definition: Pick<LoopDefinition, "goal" | "allowedIntegrations" | "allowedToolRefs">
): Pick<LoopDefinition, "allowedIntegrations" | "allowedToolRefs"> {
  const allowedIntegrations = new Set(definition.allowedIntegrations.map((v) => v.trim().toLowerCase()));
  allowedIntegrations.add("internal");
  if (goalImpliesExternalDelivery(definition.goal)) {
    allowedIntegrations.add("composio");
  }
  return {
    allowedIntegrations: [...allowedIntegrations],
    // Tool ref caps are optional; only honor explicit non-empty user caps, not stale NL-parse lists.
    allowedToolRefs: undefined,
  };
}

export function listAllowedLoopTools(
  definition: Pick<LoopDefinition, "goal" | "allowedIntegrations" | "allowedToolRefs">
): LoopCatalogToolView[] {
  const constraints = getEffectiveLoopConstraints(definition);
  const integrations = new Set(constraints.allowedIntegrations.map((v) => v.trim().toLowerCase()));
  const toolRefCap = constraints.allowedToolRefs?.length
    ? new Set(constraints.allowedToolRefs)
    : null;

  return listLoopTools().filter((tool) => {
    const entry = getLoopTool(tool.ref);
    if (!entry) return false;
    if (!integrations.has(entry.integrationKey)) return false;
    if (toolRefCap && !toolRefCap.has(tool.ref)) return false;
    return true;
  });
}

export function getLoopTool(ref: string): LoopCatalogEntry | null {
  return CATALOG_BY_REF.get(ref) ?? null;
}

function normalizeIntegrations(definition: Pick<LoopDefinition, "allowedIntegrations">): Set<string> {
  const values = new Set(["internal"]);
  for (const integration of definition.allowedIntegrations) {
    values.add(integration.trim().toLowerCase());
  }
  return values;
}

function connectedToolkits(accounts: Awaited<ReturnType<typeof listConnectorAccounts>>): Set<string> {
  const toolkits = new Set<string>();
  for (const account of accounts) {
    if (account.status !== "connected") continue;
    const appKey = account.appKey?.trim().toLowerCase();
    if (appKey) toolkits.add(appKey);
  }
  return toolkits;
}

export async function validateToolAssignments(input: {
  tools: LoopToolAssignment[];
  definition: Pick<LoopDefinition, "allowedIntegrations" | "allowedToolRefs">;
  auth: AuthContext;
  strictConnectors?: boolean;
}): Promise<{ ok: true } | { ok: false; issues: LoopToolValidationIssue[] }> {
  const issues: LoopToolValidationIssue[] = [];
  const allowedIntegrations = normalizeIntegrations(input.definition);
  const allowedToolRefs = input.definition.allowedToolRefs
    ? new Set(input.definition.allowedToolRefs)
    : null;
  const connectors = await listConnectorAccounts(input.auth);
  const toolkits = connectedToolkits(connectors);
  const strictConnectors = input.strictConnectors ?? false;

  for (const assignment of input.tools) {
    const entry = getLoopTool(assignment.ref);
    if (!entry) {
      issues.push({
        ref: assignment.ref,
        code: "unknown_tool",
        message: `Unknown tool ref: ${assignment.ref}`,
      });
      continue;
    }
    if (allowedToolRefs && !allowedToolRefs.has(entry.ref)) {
      issues.push({
        ref: entry.ref,
        code: "tool_not_allowed",
        message: `Tool ${entry.ref} is not allowed for this loop`,
      });
    }
    if (!allowedIntegrations.has(entry.integrationKey)) {
      issues.push({
        ref: entry.ref,
        code: "tool_not_allowed",
        message: `Integration ${entry.integrationKey} is not enabled for this loop`,
      });
    }
    if (entry.requiresConnector && entry.toolkit && !toolkits.has(entry.toolkit)) {
      issues.push({
        ref: entry.ref,
        code: "connector_missing",
        message: `Connect ${entry.toolkit} to use ${entry.label}`,
      });
    }
  }

  const blockingIssues = strictConnectors
    ? issues
    : issues.filter((issue) => issue.code !== "connector_missing");

  return blockingIssues.length > 0 ? { ok: false, issues: blockingIssues } : { ok: true };
}

export async function validateAgentRoster(input: {
  agents: Array<{ tools: LoopToolAssignment[] }>;
  definition: Pick<LoopDefinition, "allowedIntegrations" | "allowedToolRefs">;
  auth: AuthContext;
  strictConnectors?: boolean;
}): Promise<{ ok: true } | { ok: false; issues: LoopToolValidationIssue[] }> {
  const issues: LoopToolValidationIssue[] = [];
  for (const agent of input.agents) {
    const result = await validateToolAssignments({
      tools: agent.tools,
      definition: input.definition,
      auth: input.auth,
      strictConnectors: input.strictConnectors,
    });
    if (!result.ok) issues.push(...result.issues);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export async function listToolValidationIssues(input: {
  agents: Array<{ tools: LoopToolAssignment[] }>;
  definition: Pick<LoopDefinition, "allowedIntegrations" | "allowedToolRefs">;
  auth: AuthContext;
}): Promise<LoopToolValidationIssue[]> {
  const allowedIntegrations = normalizeIntegrations(input.definition);
  const allowedToolRefs = input.definition.allowedToolRefs
    ? new Set(input.definition.allowedToolRefs)
    : null;
  const connectors = await listConnectorAccounts(input.auth);
  const toolkits = connectedToolkits(connectors);
  const issues: LoopToolValidationIssue[] = [];

  for (const agent of input.agents) {
    for (const assignment of agent.tools) {
      const entry = getLoopTool(assignment.ref);
      if (!entry) {
        issues.push({
          ref: assignment.ref,
          code: "unknown_tool",
          message: `Unknown tool ref: ${assignment.ref}`,
        });
        continue;
      }
      if (allowedToolRefs && !allowedToolRefs.has(entry.ref)) {
        issues.push({
          ref: entry.ref,
          code: "tool_not_allowed",
          message: `Tool ${entry.ref} is not allowed for this loop`,
        });
      }
      if (!allowedIntegrations.has(entry.integrationKey)) {
        issues.push({
          ref: entry.ref,
          code: "tool_not_allowed",
          message: `Integration ${entry.integrationKey} is not enabled for this loop`,
        });
      }
      if (entry.requiresConnector && entry.toolkit && !toolkits.has(entry.toolkit)) {
        issues.push({
          ref: entry.ref,
          code: "connector_missing",
          message: `Connect ${entry.toolkit} to use ${entry.label}`,
        });
      }
    }
  }

  return issues;
}

export function summarizeCatalogForCeo(): string {
  return listLoopTools()
    .map((tool) => `- ${tool.ref}: ${tool.description}${tool.requiresConnector ? " (requires connector)" : ""}`)
    .join("\n");
}

function commentsAsContext(comments: LoopToolBindContext["priorComments"]): string {
  if (comments.length === 0) return "No prior comments yet.";
  return comments
    .map((comment) => `[${comment.author}] ${comment.body}`)
    .join("\n\n")
    .slice(-12_000);
}

function firstCommentByAuthor(comments: LoopToolBindContext["priorComments"], authorPattern: RegExp): string {
  return comments.find((comment) => authorPattern.test(comment.author))?.body ?? "";
}

export function buildAgentSystemPrompt(ctx: LoopToolBindContext): string {
  return [
    `You are ${ctx.agentName}, a specialist agent in a recurring multi-agent loop.`,
    "Complete your assigned task using prior comments as context.",
    "Do not claim external actions occurred unless a tool explicitly confirms it.",
    "If you lack information, say so clearly.",
  ].join(" ");
}

export function buildAgentUserPrompt(ctx: LoopToolBindContext): string {
  const ceoStrategy = firstCommentByAuthor(ctx.priorComments, /^ceo$/i);
  return [
    `Loop goal: ${ctx.goal}`,
    "",
    `Your task: ${ctx.agentTask}`,
    "",
    `CEO strategy:\n${ceoStrategy || "No CEO strategy comment was found."}`,
    "",
    `Prior comments:\n${commentsAsContext(ctx.priorComments)}`,
  ].join("\n");
}

export function actionableToolRefs(assignments: LoopToolAssignment[]): string[] {
  return assignments
    .map((assignment) => getLoopTool(assignment.ref))
    .filter((entry): entry is LoopCatalogEntry => Boolean(entry?.isActionable))
    .map((entry) => entry.ref);
}

export function hasOnlyLlmTools(assignments: LoopToolAssignment[]): boolean {
  if (assignments.length === 0) return true;
  return assignments.every((assignment) => {
    const entry = getLoopTool(assignment.ref);
    return !entry || !entry.isActionable || entry.ref === "internal.llm_only";
  });
}

export function buildDraftFromToolResults(input: {
  goal: string;
  toolRef: string;
  toolResult: unknown;
}): { kind: string; summary: string; payload: Record<string, unknown> } | undefined {
  const entry = getLoopTool(input.toolRef);
  if (!entry?.requiresApproval) return undefined;
  return {
    kind: entry.ref.replace(/\./g, "_"),
    summary: `Approve ${entry.label} for ${input.goal}`,
    payload: {
      goal: input.goal,
      toolRef: input.toolRef,
      composioAction: entry.composioAction ?? null,
      prepared: input.toolResult,
    },
  };
}

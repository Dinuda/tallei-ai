// @ts-nocheck
/**
 * tool-catalog.ts — Loop tool registry, validation, and agent prompt builders.
 */

import { listConnectorAccounts } from "../connectors/composio.js";

export function normalizeToolRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("composito.")) {
    return `composio.${normalized.slice("composito.".length)}`;
  }
  return normalized;
}

function mergeToolRefCaps(
  base: string[] | undefined,
  extra: string[]
): string[] | undefined {
  const merged = [...new Set([...(base ?? []), ...extra.map((ref) => normalizeToolRef(ref)).filter(Boolean)])];
  return merged.length > 0 ? merged : undefined;
}
const CATALOG = [
    {
        ref: "internal.llm_only",
        label: "LLM only",
        description: "Pure language-model completion with no external tools.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "text",
        riskLevel: "none",
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
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" }, memories: { type: "array" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "research_notes",
        riskLevel: "none",
        integrationKey: "internal",
        isActionable: true,
    },
    {
        ref: "internal.web_search",
        label: "Web search",
        description: "Search the live web using Exa webSearch only.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" }, sources: { type: "array" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "research_notes",
        riskLevel: "none",
        integrationKey: "internal",
        isActionable: true,
    },
];
const CATALOG_BY_REF = new Map(CATALOG.map((entry) => [entry.ref, entry]));
export function listLoopTools() {
    return CATALOG
        .map(({ integrationKey: _i, composioAction: _a, isActionable: _x, ...view }) => view);
}
/** Effective constraints for stable artifact-only execution. */
export function getEffectiveLoopConstraints(definition) {
    const allowedIntegrations = new Set(definition.allowedIntegrations.map((v) => v.trim().toLowerCase()));
    allowedIntegrations.add("internal");
    let allowedToolRefs = definition.allowedToolRefs?.length
        ? [...new Set(definition.allowedToolRefs.map((ref) => normalizeToolRef(ref)).filter(Boolean))]
        : undefined;
    if (definition.agentGraph?.children?.length) {
        allowedToolRefs = mergeToolRefCaps(
            allowedToolRefs,
            definition.agentGraph.children.flatMap((child) => child.tools.map((tool) => tool.ref)),
        );
    }
    return {
        allowedIntegrations: [...allowedIntegrations],
        allowedToolRefs,
    };
}
export function listAllowedLoopTools(definition) {
    const constraints = getEffectiveLoopConstraints(definition);
    const integrations = new Set(constraints.allowedIntegrations.map((v) => v.trim().toLowerCase()));
    const toolRefCap = constraints.allowedToolRefs?.length
        ? new Set(constraints.allowedToolRefs)
        : null;
    return listLoopTools().filter((tool) => {
        const entry = getLoopTool(tool.ref);
        if (!entry)
            return false;
        if (!integrations.has(entry.integrationKey))
            return false;
        if (toolRefCap && !toolRefCap.has(tool.ref))
            return false;
        return true;
    });
}
export function getLoopTool(ref) {
    return CATALOG_BY_REF.get(normalizeToolRef(ref)) ?? null;
}
function normalizeIntegrations(definition) {
    const values = new Set(["internal"]);
    for (const integration of definition.allowedIntegrations) {
        values.add(integration.trim().toLowerCase());
    }
    return values;
}
function connectedToolkits(accounts) {
    const toolkits = new Set();
    for (const account of accounts) {
        if (account.status !== "connected")
            continue;
        const appKey = account.appKey?.trim().toLowerCase();
        if (appKey)
            toolkits.add(appKey);
    }
    return toolkits;
}
export async function validateToolAssignments(input) {
    const issues = [];
    const allowedIntegrations = normalizeIntegrations(input.definition);
    const allowedToolRefs = input.definition.allowedToolRefs
        ? new Set(input.definition.allowedToolRefs.map((ref) => normalizeToolRef(ref)))
        : null;
    const connectors = await listConnectorAccounts(input.auth);
    const toolkits = connectedToolkits(connectors);
    const strictConnectors = input.strictConnectors ?? false;
    for (const assignment of input.tools) {
        const normalizedRef = normalizeToolRef(assignment.ref);
        const entry = getLoopTool(normalizedRef);
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
export async function validateAgentRoster(input) {
    const issues = [];
    for (const agent of input.agents) {
        const result = await validateToolAssignments({
            tools: agent.tools,
            definition: input.definition,
            auth: input.auth,
            strictConnectors: input.strictConnectors,
        });
        if (!result.ok)
            issues.push(...result.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
function commentsAsContext(comments) {
    if (comments.length === 0)
        return "No prior comments yet.";
    return comments
        .map((comment) => `[${comment.author}] ${comment.body}`)
        .join("\n\n")
        .slice(-12_000);
}
function firstCommentByAuthor(comments, authorPattern) {
    return comments.find((comment) => authorPattern.test(comment.author))?.body ?? "";
}
export function buildAgentSystemPrompt(ctx) {
    const isNewsletterWriter = /newsletter/i.test(`${ctx.goal} ${ctx.agentName} ${ctx.agentTask}`)
        && /\b(write|writer|draft|email|newsletter)\b/i.test(`${ctx.agentName} ${ctx.agentTask}`);
    const base = [
        `You are ${ctx.agentName}, a specialist agent in a recurring multi-agent loop.`,
        "Complete your assigned task using prior comments as context.",
        "Use only facts that are explicitly present in tool outputs, prior comments, or the loop goal. Do not invent product updates, links, metrics, offers, customer wins, memory IDs, or roadmap claims.",
        "If upstream research contains placeholders, examples, or says evidence is missing, treat those items as unavailable. Omit them or clearly say the evidence is missing; never rewrite placeholders as facts.",
        "Do not claim external actions occurred unless a tool explicitly confirms it.",
        "If producing subscriber-facing or customer-facing copy, return only that copy; omit workflow scaffolding, draft labels, approval instructions, next steps, and handoff notes.",
        "Return one final answer, not multiple variants, unless your task explicitly asks for options.",
        "Do not impersonate a real person, newsletter, publication, or third-party brand unless the loop goal explicitly says that is the authorized sender.",
        "If you lack information, say so clearly.",
    ];
    if (isNewsletterWriter) {
        base.push(
            "Newsletter writer contract: return exactly one publish-ready email draft.",
            "Line 1 must be `Subject: <one subject>` and line 2 may be `Preview: <one preview>`.",
            "Do not include subject-line options, alternate tones, one-paragraph versions, social snippets, implementation notes, or source-planning notes.",
            "Do not include personalization placeholders beyond approved mail-merge syntax already present in the template."
        );
    }
    return base.join(" ");
}
export function buildAgentUserPrompt(ctx) {
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
export function actionableToolRefs(assignments) {
    return assignments
        .map((assignment) => getLoopTool(assignment.ref))
        .filter((entry) => Boolean(entry?.isActionable))
        .map((entry) => entry.ref);
}
export function hasOnlyLlmTools(assignments) {
    if (assignments.length === 0)
        return true;
    return assignments.every((assignment) => {
        const entry = getLoopTool(assignment.ref);
        return !entry || !entry.isActionable || entry.ref === "internal.llm_only";
    });
}
export function buildDraftFromToolResults(input) {
    const entry = getLoopTool(input.toolRef);
    if (!entry?.requiresApproval)
        return undefined;
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
//# sourceMappingURL=tool-catalog.js.map

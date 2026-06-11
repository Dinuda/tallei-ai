// @ts-nocheck
/**
 * tool-catalog.ts — Loop tool registry, validation, and agent prompt builders.
 */

import { connectedAppToolkits, listComposioToolkitTools, listConnectorAccounts } from "../connectors/composio.js";
import { buildComposioActionContract, buildConnectedSearchContract, getStaticToolContract } from "../tool-spec/tool-contracts.js";

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
        contract: getStaticToolContract("internal.llm_only"),
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
        contract: getStaticToolContract("internal.memory_search"),
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
        contract: getStaticToolContract("internal.web_search"),
    },
    {
        ref: "composio.gmail.search",
        label: "Gmail search",
        description: "Search and summarize connected Gmail messages. Read-only; does not send email.",
        provider: "composio",
        toolkit: "gmail",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "gmail",
        isActionable: true,
        composioToolkit: "gmail",
        contract: buildConnectedSearchContract("gmail"),
    },
    {
        ref: "composio.slack.search",
        label: "Slack search",
        description: "Search and summarize connected Slack messages or channels. Read-only; does not post.",
        provider: "composio",
        toolkit: "slack",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "slack",
        isActionable: true,
        composioToolkit: "slack",
        contract: buildConnectedSearchContract("slack"),
    },
    {
        ref: "composio.googlecalendar.search",
        label: "Google Calendar search",
        description: "Search and summarize connected Google Calendar events. Read-only; does not create events.",
        provider: "composio",
        toolkit: "googlecalendar",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "googlecalendar",
        isActionable: true,
        composioToolkit: "googlecalendar",
        contract: buildConnectedSearchContract("googlecalendar"),
    },
    {
        ref: "composio.github.search",
        label: "GitHub search",
        description: "Search and summarize connected GitHub repositories, issues, pull requests, or commits. Read-only.",
        provider: "composio",
        toolkit: "github",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "github",
        isActionable: true,
        composioToolkit: "github",
        contract: buildConnectedSearchContract("github"),
    },
    {
        ref: "composio.notion.search",
        label: "Notion search",
        description: "Search and summarize connected Notion pages or databases. Read-only; does not create pages.",
        provider: "composio",
        toolkit: "notion",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "notion",
        isActionable: true,
        composioToolkit: "notion",
        contract: buildConnectedSearchContract("notion"),
    },
    {
        ref: "composio.linear.search",
        label: "Linear search",
        description: "Search and summarize connected Linear issues, projects, or cycles. Read-only.",
        provider: "composio",
        toolkit: "linear",
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: "linear",
        isActionable: true,
        composioToolkit: "linear",
        contract: buildConnectedSearchContract("linear"),
    },
];
const CATALOG_BY_REF = new Map(CATALOG.map((entry) => [entry.ref, entry]));

function connectedSearchTool(toolkit) {
    const key = normalizeToolRef(toolkit);
    return {
        ref: `composio.${key}.search`,
        label: `${key} search`,
        description: `Search and summarize connected ${key} data. Read-only; does not mutate the connected app.`,
        provider: "composio",
        toolkit: key,
        requiresConnector: true,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        requiredArtifactKinds: [],
        producesArtifactKind: "app_context",
        riskLevel: "low",
        integrationKey: key,
        isActionable: true,
        composioToolkit: key,
        dynamic: true,
        contract: buildConnectedSearchContract(key),
    };
}

function parseComposioActionRef(ref) {
    const match = normalizeToolRef(ref).match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
    if (!match)
        return null;
    return { toolkit: match[1], actionSlug: match[2] };
}

function dynamicActionTool(toolkit, action) {
    const riskLevel = action.risk === "read" ? "low" : action.risk === "write" ? "medium" : "high";
    return {
        ref: `composio.${toolkit}.action.${normalizeToolRef(action.actionSlug)}`,
        label: action.name || action.actionSlug,
        description: action.description || `${action.risk} Composio action for ${toolkit}`,
        provider: "composio",
        toolkit,
        requiresConnector: true,
        requiresApproval: action.risk !== "read",
        inputSchema: action.inputSchema || { type: "object" },
        outputSchema: { type: "object" },
        requiredArtifactKinds: [],
        producesArtifactKind: action.risk === "read" ? "app_context" : "connector_action_result",
        riskLevel,
        integrationKey: toolkit,
        isActionable: true,
        composioToolkit: toolkit,
        composioAction: action.actionSlug,
        actionRisk: action.risk,
        dynamic: true,
        contract: buildComposioActionContract({
            toolkit,
            actionSlug: action.actionSlug,
            name: action.name || action.actionSlug,
            description: action.description,
            risk: action.risk,
            inputSchema: action.inputSchema || { type: "object" },
        }),
    };
}

export function listLoopTools() {
    return CATALOG
        .map(({ integrationKey: _i, composioAction: _a, isActionable: _x, ...view }) => view);
}
export async function listAvailableLoopToolsForAuth(auth) {
    const accounts = await listConnectorAccounts(auth).catch(() => []);
    const connected = new Set(connectedAppToolkits(accounts));
    const staticTools = listLoopTools().filter((tool) => {
        const entry = getLoopTool(tool.ref);
        if (!entry)
            return false;
        if (!entry.requiresConnector)
            return true;
        return Boolean(entry.toolkit && connected.has(entry.toolkit));
    });
    const dynamicSearchTools = [...connected].map(connectedSearchTool);
    return [...staticTools, ...dynamicSearchTools.filter((tool) => !staticTools.some((existing) => existing.ref === tool.ref))];
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
    const normalized = normalizeToolRef(ref);
    const staticTool = CATALOG_BY_REF.get(normalized);
    if (staticTool)
        return staticTool;
    const searchMatch = normalized.match(/^composio\.([a-z0-9_-]+)\.search$/);
    if (searchMatch)
        return connectedSearchTool(searchMatch[1]);
    const action = parseComposioActionRef(normalized);
    if (action) {
        return dynamicActionTool(action.toolkit, {
            toolkit: action.toolkit,
            actionSlug: action.actionSlug,
            name: action.actionSlug,
            description: `Approved Composio action ${action.actionSlug}`,
            risk: "write",
            inputSchema: { type: "object" },
        });
    }
    return null;
}
export function isKnownLoopToolRef(ref) {
    return Boolean(getLoopTool(ref));
}
export async function listAvailableConnectorActionTools(input) {
    const actions = await listComposioToolkitTools(input.toolkit);
    return actions.map((action) => dynamicActionTool(normalizeToolRef(input.toolkit), action));
}
function normalizeIntegrations(definition) {
    const values = new Set(["internal"]);
    for (const integration of definition.allowedIntegrations) {
        values.add(integration.trim().toLowerCase());
    }
    return values;
}
export async function validateToolAssignments(input) {
    const issues = [];
    const allowedIntegrations = normalizeIntegrations(input.definition);
    const allowedToolRefs = input.definition.allowedToolRefs
        ? new Set(input.definition.allowedToolRefs.map((ref) => normalizeToolRef(ref)))
        : null;
    const connectors = await listConnectorAccounts(input.auth);
    const toolkits = new Set(connectedAppToolkits(connectors));
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
function stringifyHandoffValue(value, maxChars) {
    if (typeof value === "string")
        return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]` : value;
    try {
        const text = JSON.stringify(value, null, 2);
        return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]` : text;
    }
    catch {
        return String(value);
    }
}
function handoffAsContext(handoff) {
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff))
        return "No structured handoff was provided.";
    const entries = Object.entries(handoff);
    if (entries.length === 0)
        return "No structured handoff was provided.";
    const priorityKeys = ["user_profile", "user_profile_memories", "operator_input", "sprint_notes", "approved_memories", "memories"];
    const priority = [];
    const rest = [];
    for (const entry of entries) {
        if (priorityKeys.includes(entry[0]))
            priority.push(entry);
        else
            rest.push(entry);
    }
    return [...priority, ...rest]
        .map(([key, value]) => {
            const maxChars = key === "sprint_notes" || key === "operator_input"
                ? 6000
                : key === "user_profile" || key === "user_profile_memories"
                    ? 4000
                    : 3000;
            return `### ${key}\n${stringifyHandoffValue(value, maxChars)}`;
        })
        .join("\n\n")
        .slice(0, 24_000);
}
function firstCommentByAuthor(comments, authorPattern) {
    return comments.find((comment) => authorPattern.test(comment.author))?.body ?? "";
}
export function buildAgentSystemPrompt(ctx) {
    const isNewsletterWriter = ctx.renderTarget === "canvas.email" || ctx.renderTarget === "canvas.preview"
        || (/newsletter|email/i.test(`${ctx.goal} ${ctx.agentName} ${ctx.agentTask}`)
            && /\b(write|writer|draft|email|newsletter)\b/i.test(`${ctx.agentName} ${ctx.agentTask}`));
    const base = [
        `You are ${ctx.agentName}, a specialist agent in a recurring multi-agent loop.`,
        "Complete your assigned task using prior comments as context.",
        "Use only facts that are explicitly present in tool outputs, prior comments, or the loop goal. Do not invent product updates, links, metrics, offers, customer wins, memory IDs, or roadmap claims.",
        "When user_profile is present in the handoff, match its tone, writing style, sign-off, and identity constraints exactly.",
        "If upstream research contains placeholders, examples, or says evidence is missing, treat those items as unavailable. Omit them or clearly say the evidence is missing; never rewrite placeholders as facts.",
        "Do not claim external actions occurred unless a tool explicitly confirms it.",
        "If producing subscriber-facing or customer-facing copy, return only that copy; omit workflow scaffolding, draft labels, approval instructions, send-plan notes, placeholder guidance, signature scaffolding, and handoff notes.",
        "Return one final answer, not multiple variants, unless your task explicitly asks for options.",
        "Do not impersonate a real person, newsletter, publication, or third-party brand unless the loop goal explicitly says that is the authorized sender.",
        "If you lack information, say so clearly.",
        `MANDATORY OUTPUT CONTRACT: ${ctx.outputContract?.description ?? "Return only the completed task output."}`,
        ...(isNewsletterWriter
            ? ["MANDATORY OUTPUT REPRESENTATION: raw email_markdown text only. Do not return JSON or wrap the email in a `text`, `body`, or `content` object."]
            : [`MANDATORY OUTPUT SCHEMA: ${JSON.stringify(ctx.outputContract?.schema ?? { text: "string" })}`]),
        `DONE CRITERIA: ${(ctx.doneCriteria ?? []).join("; ") || "Complete the assigned task."}`,
        "Your response must satisfy the output contract exactly. Do not add fields, sections, variants, or commentary not requested by it.",
    ];
    if (isNewsletterWriter) {
        base.push(
            "Email writer contract: return exactly one email in canonical email_markdown format.",
            "Line 1 must be `Subject: <one subject>`, line 2 may be `Preview: <one preview>`, followed by one blank line and the Markdown body.",
            "Do not include subject-line options, alternate tones, one-paragraph versions, social snippets, implementation notes, source-planning notes, or any commentary about the draft itself.",
            "Do not include ready-to-send language, placeholder notes, recipient instructions, send-plan sections, or personalization placeholders beyond approved mail-merge syntax already present in the template.",
            "Raw HTML, HTML comments, code fences, HTML-friendly versions, plain-text alternate versions, and multiple representations are forbidden."
        );
    }
    return base.join(" ");
}
export function buildAgentUserPrompt(ctx) {
    const ceoStrategy = firstCommentByAuthor(ctx.priorComments, /^ceo$/i);
    return [
        "Authoritative agent handoff:",
        handoffAsContext(ctx.agentHandoff),
        "",
        "Use the handoff above as the source of truth for named inputs and upstream artifacts. If the loop goal contains placeholder text but the handoff contains a real value for that field, use the handoff value.",
        "",
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

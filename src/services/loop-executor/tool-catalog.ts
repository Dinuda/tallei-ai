// @ts-nocheck
/**
 * tool-catalog.ts — Loop tool registry, validation, and agent prompt builders.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { listConnectorAccounts } from "../connectors/composio.js";
import { presetToolRefsForDefinition } from "./presets/registry.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

function mergeToolRefCaps(
  base: string[] | undefined,
  extra: string[]
): string[] | undefined {
  const merged = [...new Set([...(base ?? []), ...extra.map((ref) => ref.trim()).filter(Boolean)])];
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
    {
        ref: "internal.email_approval_request",
        label: "Email approval",
        description: "Send the current run artifact to the operator via the Resend email adapter for approval.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] },
        outputSchema: { type: "object", properties: { approvalUrl: { type: "string" }, token: { type: "string" } }, required: ["approvalUrl", "token"] },
        requiredArtifactKinds: ["draft", "message", "outbound_payload", "content"],
        producesArtifactKind: "approval_request",
        riskLevel: "review",
        integrationKey: "internal",
        isActionable: true,
    },
    {
        ref: "internal.resend_broadcast",
        label: "Resend broadcast",
        description: "Send an approved artifact to an uploaded recipient list through the Resend broadcast runner.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: true,
        inputSchema: { type: "object", properties: { contentArtifactId: { type: "string" }, recipientsArtifactId: { type: "string" } }, required: ["contentArtifactId", "recipientsArtifactId"] },
        outputSchema: { type: "object", properties: { broadcastId: { type: "string" }, successCount: { type: "number" }, failureCount: { type: "number" } }, required: ["successCount", "failureCount"] },
        requiredArtifactKinds: ["content", "draft", "message", "contact_list"],
        producesArtifactKind: "delivery_result",
        riskLevel: "external_action",
        integrationKey: "internal",
        isActionable: true,
    },
    {
        ref: "internal.react_email_template",
        label: "React Email template",
        description: "Render newsletter broadcast HTML with an optional React Email template before Resend sends it.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { templateId: { type: "string" } } },
        outputSchema: { type: "object", properties: { html: { type: "string" }, text: { type: "string" } } },
        requiredArtifactKinds: ["content", "draft", "message"],
        producesArtifactKind: "email_template",
        riskLevel: "none",
        integrationKey: "react_email",
        isActionable: false,
    },
    {
        ref: "composio.gmail.create_draft",
        label: "Gmail draft",
        description: "Prepare a Gmail draft for human approval before sending.",
        provider: "composio",
        toolkit: "gmail",
        requiresConnector: true,
        requiresApproval: true,
        inputSchema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, recipientEmail: { type: "string" } }, required: ["subject", "body"] },
        outputSchema: { type: "object", properties: { draftId: { type: "string" }, subject: { type: "string" }, body: { type: "string" } } },
        requiredArtifactKinds: ["message", "draft", "content"],
        producesArtifactKind: "draft",
        riskLevel: "review",
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
        inputSchema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, recipientEmail: { type: "string" } }, required: ["subject", "body", "recipientEmail"] },
        outputSchema: { type: "object", properties: { messageId: { type: "string" }, status: { type: "string" } } },
        requiredArtifactKinds: ["message", "draft"],
        producesArtifactKind: "delivery_result",
        riskLevel: "external_action",
        integrationKey: "composio",
        composioAction: "GMAIL_SEND_EMAIL",
        isActionable: true,
    },
    {
        ref: "internal.email_builder_compose",
        label: "Email builder",
        description: "Compose and edit email templates using the Waypoint EmailBuilder.js JSON format.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { document: { type: "object" } }, required: ["document"] },
        outputSchema: { type: "object", properties: { document: { type: "object" }, html: { type: "string" } }, required: ["document", "html"] },
        requiredArtifactKinds: ["draft", "message", "content"],
        producesArtifactKind: "email_template",
        riskLevel: "none",
        integrationKey: "internal",
        isActionable: true,
    },
    {
        ref: "internal.email_builder_render",
        label: "Render email",
        description: "Render a Waypoint EmailBuilder.js JSON document to HTML.",
        provider: "internal",
        toolkit: null,
        requiresConnector: false,
        requiresApproval: false,
        inputSchema: { type: "object", properties: { document: { type: "object" } }, required: ["document"] },
        outputSchema: { type: "object", properties: { html: { type: "string" } }, required: ["html"] },
        requiredArtifactKinds: ["email_template", "draft", "message", "content"],
        producesArtifactKind: "email_html",
        riskLevel: "none",
        integrationKey: "internal",
        isActionable: true,
    },
];
const CATALOG_BY_REF = new Map(CATALOG.map((entry) => [entry.ref, entry]));
export function listLoopTools() {
    return CATALOG.map(({ integrationKey: _i, composioAction: _a, isActionable: _x, ...view }) => view);
}
function goalImpliesExternalDelivery(goal) {
    return /\b(email|gmail|outlook|slack|discord|publish|send|deliver|distribute|post)\b/i.test(goal);
}
/** Effective constraints for validation/prompting — repairs overly narrow create-time caps. */
export function getEffectiveLoopConstraints(definition) {
    const allowedIntegrations = new Set(definition.allowedIntegrations.map((v) => v.trim().toLowerCase()));
    allowedIntegrations.add("internal");
    if (goalImpliesExternalDelivery(definition.goal)) {
        allowedIntegrations.add("composio");
    }
    let allowedToolRefs = definition.allowedToolRefs?.length
        ? [...definition.allowedToolRefs]
        : undefined;
    if (definition.agentGraph?.children?.length) {
        allowedToolRefs = mergeToolRefCaps(
            allowedToolRefs,
            definition.agentGraph.children.flatMap((child) => child.tools.map((tool) => tool.ref)),
        );
    }
    allowedToolRefs = mergeToolRefCaps(allowedToolRefs, presetToolRefsForDefinition(definition));
    if (definition.plan?.stages?.length) {
        allowedToolRefs = mergeToolRefCaps(
            allowedToolRefs,
            definition.plan.stages.flatMap((stage) => {
                if (stage.kind === "agent" && stage.toolRef) return [stage.toolRef];
                if (stage.kind === "external_action") return [stage.toolRef];
                return [];
            }),
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
    return CATALOG_BY_REF.get(ref) ?? null;
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
    return [
        `You are ${ctx.agentName}, a specialist agent in a recurring multi-agent loop.`,
        "Complete your assigned task using prior comments as context.",
        "Do not claim external actions occurred unless a tool explicitly confirms it.",
        "If producing subscriber-facing or customer-facing copy, return only that copy; omit workflow scaffolding, draft labels, approval instructions, next steps, and handoff notes.",
        "Do not impersonate a real person, newsletter, publication, or third-party brand unless the loop goal explicitly says that is the authorized sender.",
        "If you lack information, say so clearly.",
    ].join(" ");
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

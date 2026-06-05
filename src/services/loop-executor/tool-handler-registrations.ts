/**
 * tool-handler-registrations.ts — Registers all built-in tool handlers.
 *
 * Called once at module load. Each handler is extracted from the
 * inline code that was previously in agent-runner.ts's runAssignedTools().
 */

import { config } from "../../config/index.js";
import { recallMemories } from "../memory.js";
import { sendWorkflowRunApprovalPrompt, getPrimaryNotificationChannel } from "../channels.js";
import { createWorkflowApprovalRequest } from "../approval-tokens.js";
import { buildDraftFromToolResults } from "./tool-catalog.js";
import { isNewsletterLoopDefinition, resolveDeliveryFormatter } from "./delivery-format.js";
import { registerToolHandler, type ToolHandlerContext } from "./tool-handlers.js";
import { loopExecutorOpenAiChat, loopExecutorOpenAiModel } from "./openai-chat.js";
import { readMemorySearchConfig, readGatewaySearchConfig, runExaWebSearch, completeText } from "./agent-runner-internals.js";

registerToolHandler("internal.memory_search", async (ctx: ToolHandlerContext) => {
  const memoryConfig = readMemorySearchConfig(ctx.assignment.config, ctx.agent.task);
  const result = await recallMemories(memoryConfig.query, ctx.auth, memoryConfig.limit);
  const text = ["Memory search results:", ...result.memories.map((m) => `- ${m.text}`)].join("\n");
  return { text };
});

registerToolHandler("internal.web_search", async (ctx: ToolHandlerContext) => {
  const result = await runExaWebSearch({ goal: ctx.goal, task: ctx.agent.task, config: ctx.assignment.config });
  const text = [`Web search results (${result.model}):`, result.text].join("\n");
  return { text, data: { model: result.model, provider: result.provider }, shortCircuit: true };
});

registerToolHandler("internal.email_approval_request", async (ctx: ToolHandlerContext) => {
  if (!ctx.runId || !ctx.workflowId) throw new Error("Email approval requires an active loop run context");
  const artifactBody = extractApprovalBodyFromComments(ctx.priorComments);
  if (!artifactBody.trim()) throw new Error("Content is required before sending the approval request");

  const formatter = resolveDeliveryFormatter(ctx.definition!, artifactBody);
  const formatted = formatter.formatForDelivery(artifactBody);
  const approvalSubject = formatted.subject
    ? `Approval required: ${formatted.subject}`
    : `Approval required: ${ctx.workflowTitle ?? "Loop run"}`;

  const primaryChannel = await getPrimaryNotificationChannel(ctx.auth);
  const approval = await createWorkflowApprovalRequest({
    auth: ctx.auth,
    targetType: "workflow_run",
    targetId: ctx.runId,
    channel: primaryChannel?.kind === "telegram" || primaryChannel?.kind === "gmail" ? primaryChannel.kind : "email",
  });
  const approvalUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/loops/approvals/${approval.token}/approve`;

  let renderedEmail: { html: string; text: string } | null = null;
  if (isNewsletterLoopDefinition(ctx.definition!)) {
    try {
      const module = await import("./presets/newsletter-react-email.js");
      renderedEmail = await module.renderNewsletterApprovalEmail({
        subject: formatted.subject ?? ctx.workflowTitle ?? "Loop run",
        markdown: formatted.text || artifactBody,
        approvalUrl,
        runUrl: ctx.workflowId
          ? `${config.frontendUrl.replace(/\/$/, "")}/dashboard/loops/${ctx.workflowId}/runs/${ctx.runId}`
          : approvalUrl,
      });
    } catch {
      renderedEmail = null;
    }
  }

  const sentPrompt = await sendWorkflowRunApprovalPrompt({
    auth: ctx.auth,
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    workflowTitle: ctx.workflowTitle ?? "Loop run",
    artifactBody,
    approvalUrl,
    approvalToken: approval.token,
    artifactKind: "draft",
    emailSubject: approvalSubject,
    renderedEmail,
  });

  return {
    text: `Approval request sent to ${sentPrompt.to}`,
    emailApprovalSent: true,
    approvalRequest: { ...sentPrompt, approvalUrl, token: approval.token },
    artifactBody,
    shortCircuit: true,
  };
});

registerToolHandler("internal.email_builder_render", async (ctx: ToolHandlerContext) => {
  const document = ctx.assignment.config?.document;
  if (!document || typeof document !== "object") {
    throw new Error("Email builder render requires a document config");
  }
  try {
    const module = await import("./presets/newsletter-waypoint.js");
    const html = module.renderWaypointEmail(document as import("./presets/newsletter-waypoint.js").WaypointDocument);
    return { text: `Rendered email HTML (${html.length} bytes):\n${html.slice(0, 500)}${html.length > 500 ? "..." : ""}` };
  } catch {
    return { text: "Email builder render is not available (waypoint module not found)." };
  }
});

registerToolHandler("internal.email_builder_compose", async () => {
  return { text: "Email builder compose tool is available. Use the UI to edit the email template." };
});

function extractApprovalBodyFromComments(comments: Array<{ author: string; body: string }>): string {
  const ordered = comments.filter((c) => c.body.trim().length > 0);
  if (ordered.length === 0) return "";
  let lastAgent: { author: string; body: string } | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].author !== "user" && ordered[i].author !== "ceo") {
      lastAgent = ordered[i];
      break;
    }
  }
  return (lastAgent ?? ordered[ordered.length - 1]).body;
}

registerToolHandler("composio.gmail.create_draft", async (ctx: ToolHandlerContext) => {
  return handleComposioApprovalTool(ctx, "Gmail draft");
});

registerToolHandler("composio.gmail.send_email", async (ctx: ToolHandlerContext) => {
  return handleComposioApprovalTool(ctx, "Gmail send");
});

async function handleComposioApprovalTool(ctx: ToolHandlerContext, label: string) {
  const prepared = await completeText({
    system: `You prepare ${label} content for human approval. Do not claim the external action happened.`,
    user: [`Goal: ${ctx.goal}`, `Task: ${ctx.agent.task}`, 'Return JSON: {"subject":"","body":"","recipient_email":""}'].join("\n"),
    maxTokens: 1200,
  });
  let payload: Record<string, unknown> = { raw: prepared };
  try { payload = JSON.parse(prepared) as Record<string, unknown>; } catch { payload = { body: prepared }; }
  const draft = buildDraftFromToolResults({ goal: ctx.goal, toolRef: ctx.assignment.ref, toolResult: payload });
  return {
    text: `Prepared ${label} payload for approval:\n${JSON.stringify(payload, null, 2)}`,
    draft,
  };
}

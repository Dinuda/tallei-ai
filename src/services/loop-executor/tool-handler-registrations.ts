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
import { buildUnlayerNewsletterEmail } from "./presets/newsletter-unlayer.js";
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
  let emailTemplate: { html: string; text: string; design: unknown; subject: string | null; updatedAt: string; source: string } | undefined;
  if (isNewsletterLoopDefinition(ctx.definition!)) {
    try {
      const built = buildUnlayerNewsletterEmail({
        subject: formatted.subject ?? ctx.workflowTitle ?? "Loop run",
        markdown: formatted.text || artifactBody,
      });
      emailTemplate = {
        html: built.html,
        text: built.text,
        design: built.design,
        subject: built.subject,
        updatedAt: new Date().toISOString(),
        source: "builder",
      };
      renderedEmail = { html: built.html, text: built.text };
    } catch {
      renderedEmail = null;
      emailTemplate = undefined;
    }
  }

  let sentPrompt: { to: string; sentAt: string; channel?: string };
  let channelNote = "";
  try {
    sentPrompt = await sendWorkflowRunApprovalPrompt({
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sentPrompt = {
      to: primaryChannel?.destination ?? "dashboard",
      sentAt: new Date().toISOString(),
      channel: primaryChannel?.kind ?? "ui",
    };
    channelNote = ` Channel delivery failed (${message}). Approve in the dashboard or retry notification.`;
  }

  return {
    text: `Approval request sent to ${sentPrompt.to}.${channelNote}`,
    emailApprovalSent: true,
    approvalRequest: { ...sentPrompt, approvalUrl, token: approval.token },
    artifactBody,
    emailTemplate,
    shortCircuit: true,
  };
});

registerToolHandler("internal.email_builder_render", async (ctx: ToolHandlerContext) => {
  const document = ctx.assignment.config?.document;
  const artifactBody = extractApprovalBodyFromComments(ctx.priorComments);
  if ((!document || typeof document !== "object") && artifactBody.trim()) {
    const formatter = ctx.definition
      ? resolveDeliveryFormatter(ctx.definition, artifactBody)
      : null;
    const formatted = formatter?.formatForDelivery(artifactBody) ?? { text: artifactBody, subject: null };
    const built = buildUnlayerNewsletterEmail({
      subject: formatted.subject ?? ctx.workflowTitle ?? "Loop run",
      markdown: formatted.text || artifactBody,
    });
    return {
      text: `Rendered Unlayer builder email HTML (${built.html.length} bytes) from writer draft.`,
      emailTemplate: {
        html: built.html,
        text: built.text,
        design: built.design,
        subject: built.subject,
        updatedAt: new Date().toISOString(),
        source: "builder",
      },
    };
  }
  if (!document || typeof document !== "object") {
    return { text: "Email builder render skipped — no document config yet. Use the builder in the dashboard or approve the markdown draft." };
  }
  try {
    const module = await import("./presets/newsletter-waypoint.js");
    const html = module.renderWaypointEmail(document as import("./presets/newsletter-waypoint.js").WaypointDocument);
    return { text: `Rendered email HTML (${html.length} bytes):\n${html.slice(0, 500)}${html.length > 500 ? "..." : ""}` };
  } catch {
    return { text: "Email builder render is not available (waypoint module not found)." };
  }
});

registerToolHandler("internal.email_builder_compose", async (ctx: ToolHandlerContext) => {
  const artifactBody = extractApprovalBodyFromComments(ctx.priorComments);
  if (!artifactBody.trim()) return { text: "Email builder compose skipped — no writer draft is available yet." };
  const formatter = ctx.definition
    ? resolveDeliveryFormatter(ctx.definition, artifactBody)
    : null;
  const formatted = formatter?.formatForDelivery(artifactBody) ?? { text: artifactBody, subject: null };
  const built = buildUnlayerNewsletterEmail({
    subject: formatted.subject ?? ctx.workflowTitle ?? "Loop run",
    markdown: formatted.text || artifactBody,
  });
  return {
    text: `Composed Unlayer builder design from writer draft. Subject: ${built.subject}`,
    emailTemplate: {
      html: built.html,
      text: built.text,
      design: built.design,
      subject: built.subject,
      updatedAt: new Date().toISOString(),
      source: "builder",
    },
  };
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

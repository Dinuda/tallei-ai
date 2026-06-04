/**
 * agent-runner.ts — Executes a single loop agent task (tools + LLM).
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { recallMemories } from "../memory.js";
import { config } from "../../config/index.js";
import { sendWorkflowRunApprovalPrompt, getPrimaryNotificationChannel } from "../channels.js";
import { createWorkflowApprovalRequest } from "../approval-tokens.js";
import { isNewsletterLoopDefinition } from "./delivery-format.js";
import { extractPrimaryContentFromComments } from "./presets/newsletter.js";
import {
  actionableToolRefs,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  buildDraftFromToolResults,
  getLoopTool,
  hasOnlyLlmTools,
} from "./tool-catalog.js";
import { loopExecutorOpenAiChat, loopExecutorOpenAiModel } from "./openai-chat.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

function readLoopAgentTimeoutMs(): number {
  const raw = process.env.TALLEI_LOOP_EXECUTOR__AGENT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

async function withAbortTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, timeoutLabel: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readGatewaySearchConfig(raw: unknown) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const domainsRaw = Array.isArray(record.allowedDomains)
    ? record.allowedDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  const contextSizeRaw = typeof record.searchContextSize === "string" ? record.searchContextSize : null;
  const countryRaw = typeof record.country === "string" ? record.country : null;
  const contextSize = contextSizeRaw === "low" || contextSizeRaw === "medium" || contextSizeRaw === "high" ? contextSizeRaw : "medium";
  return {
    allowedDomains: domainsRaw.slice(0, 20),
    contextSize,
    country: countryRaw?.trim().toUpperCase() || "US",
  };
}

function readMemorySearchConfig(raw: unknown, fallbackTask: string) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawLimit = typeof record.limit === "number"
    ? record.limit
    : typeof record.limit === "string"
      ? Number.parseInt(record.limit, 10)
      : Number.NaN;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(20, Math.max(1, Math.floor(rawLimit)))
    : 5;
  const configuredQuery = typeof record.query === "string" && record.query.trim()
    ? record.query.trim()
    : "";
  const query = configuredQuery || fallbackTask.slice(0, 500);
  return { query, limit };
}

async function runExaWebSearch(input: { goal: string; task: string; config?: Record<string, unknown> }) {
  const searchConfig = readGatewaySearchConfig(input.config);
  const exaApiKey = process.env.EXA_API_KEY?.trim() || "";
  if (!exaApiKey) throw new Error("EXA_API_KEY is required for internal.web_search.");

  const query = [input.task.trim(), "", `Goal context: ${input.goal.trim()}`, "Focus on recent, credible sources."].join("\n");
  const data = await withAbortTimeout(readLoopAgentTimeoutMs(), async (signal) => {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "x-api-key": exaApiKey, "x-exa-integration": "tallei-loop-executor" },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 8,
        userLocation: searchConfig.country,
        includeDomains: searchConfig.allowedDomains.length > 0 ? searchConfig.allowedDomains : undefined,
        contents: { text: { maxCharacters: 1200 }, highlights: true, summary: true, livecrawl: "fallback" },
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Exa API error ${response.status}: ${body.slice(0, 500)}`);
    }
    return response.json() as Promise<{ results?: unknown[] }>;
  }, "Exa web search call");

  const results = (Array.isArray(data.results) ? data.results : [])
    .map((row) => {
      const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Untitled";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) return null;
      const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : null;
      const highlights = Array.isArray(record.highlights)
        ? record.highlights.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        : [];
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const snippet = summary || highlights[0] || (text ? text.slice(0, 260) : "No snippet available.");
      return { title, url, snippet };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (results.length === 0) throw new Error("Exa returned no results for this query.");

  const text = [
    "Top themes:",
    ...results.slice(0, 4).map((row) => `- ${row.title}`),
    "",
    "Evidence:",
    ...results.slice(0, 8).map((row) => `- ${row.title}\n  URL: ${row.url}\n  Summary: ${row.snippet.replace(/\s+/g, " ").slice(0, 320)}`),
  ].join("\n");
  return { text, model: "exa-search", provider: "exa_web_search" };
}

async function completeText(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const response = await withAbortTimeout(readLoopAgentTimeoutMs(), (signal) => loopExecutorOpenAiChat({
    messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
    temperature: 0.3,
    maxTokens: input.maxTokens ?? 1600,
    signal,
  }), "Loop agent model call");
  const text = response.text.trim();
  if (!text) throw new Error("Loop agent LLM returned an empty response");
  return text;
}

function extractApprovalBodyFromComments(comments: Array<{ author: string; body: string }>): string {
  return extractPrimaryContentFromComments(comments);
}

function shouldRenderNewsletterEmail(input: {
  goal: string;
  artifactBody: string;
  definition?: LoopDefinition | null;
}): boolean {
  return Boolean(input.definition && isNewsletterLoopDefinition(input.definition))
    || looksLikeNewsletterApproval(input);
}

function looksLikeNewsletterApproval(input: { goal: string; artifactBody: string; definition?: LoopDefinition | null }): boolean {
  return input.definition?.presetId === "newsletter"
    || input.definition?.presetId === "newsletter_v1"
    || /\bnewsletter\b/i.test(input.goal)
    || /\bnewsletter|product builders|weekly product|subscribers?\b/i.test(input.artifactBody);
}

export type RunLoopAgentInput = {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignedTools: LoopToolAssignment[];
  draftPolicy: LoopDefinition["draftPolicy"];
  priorComments: Array<{ author: string; body: string; taskId?: string | null; createdAt?: string }>;
  runId?: string;
  workflowId?: string;
  workflowTitle?: string;
  definition?: LoopDefinition;
};

export type RunLoopAgentResult = {
  text: string;
  data: Record<string, unknown>;
  draft?: unknown;
  emailApprovalSent?: boolean;
  approvalRequest?: { to: string; approvalUrl: string; token: string; sentAt: string; channel?: string };
  artifactBody?: string;
};

async function runAssignedTools(input: RunLoopAgentInput) {
  const sections: string[] = [];
  const toolsUsed: string[] = [];
  let draft: unknown;

  for (const assignment of input.assignedTools) {
    const entry = getLoopTool(assignment.ref);
    if (!entry?.isActionable || entry.ref === "internal.llm_only") continue;

    if (entry.ref === "internal.memory_search") {
      const memoryConfig = readMemorySearchConfig(assignment.config, input.agent.task);
      const result = await recallMemories(memoryConfig.query, input.auth, memoryConfig.limit);
      toolsUsed.push(entry.ref);
      sections.push(["Memory search results:", ...result.memories.map((m) => `- ${m.text}`)].join("\n"));
      continue;
    }

    if (entry.ref === "internal.web_search") {
      const result = await runExaWebSearch({ goal: input.goal, task: input.agent.task, config: assignment.config });
      toolsUsed.push(entry.ref);
      sections.push([`Web search results (${result.model}):`, result.text].join("\n"));
      continue;
    }

    if (entry.ref === "internal.email_approval_request") {
      if (!input.runId || !input.workflowId) throw new Error("Email approval requires an active loop run context");
      const artifactBody = extractApprovalBodyFromComments(
        input.priorComments.map((c) => ({ author: c.author, body: c.body }))
      );
      if (!artifactBody.trim()) throw new Error("Content is required before sending the approval request");
      const newsletterFormat = await import("./presets/newsletter.js")
        .then((module) => module.formatNewsletterForEmail(artifactBody))
        .catch(() => ({ subject: null, text: artifactBody, html: "" }));
      const approvalSubject = newsletterFormat.subject
        ? `Approval required: ${newsletterFormat.subject}`
        : `Approval required: ${input.workflowTitle ?? "Loop run"}`;

      const primaryChannel = await getPrimaryNotificationChannel(input.auth);
      const approval = await createWorkflowApprovalRequest({
        auth: input.auth,
        targetType: "workflow_run",
        targetId: input.runId,
        channel: primaryChannel?.kind === "telegram" || primaryChannel?.kind === "gmail" ? primaryChannel.kind : "email",
      });
      const approvalUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/loops/approvals/${approval.token}/approve`;
      const renderedEmail = shouldRenderNewsletterEmail({
        goal: input.goal,
        artifactBody,
        definition: input.definition,
      })
        ? await import("./presets/newsletter-react-email.js").then((module) => module.renderNewsletterApprovalEmail({
          subject: newsletterFormat.subject ?? input.workflowTitle ?? "Loop run",
          markdown: newsletterFormat.text || artifactBody,
          approvalUrl,
          runUrl: input.workflowId ? `${config.frontendUrl.replace(/\/$/, "")}/dashboard/loops/${input.workflowId}/runs/${input.runId}` : approvalUrl,
        }))
        : null;
      const sentPrompt = await sendWorkflowRunApprovalPrompt({
        auth: input.auth,
        runId: input.runId,
        workflowId: input.workflowId,
        workflowTitle: input.workflowTitle ?? "Loop run",
        artifactBody,
        approvalUrl,
        approvalToken: approval.token,
        artifactKind: "draft",
        emailSubject: approvalSubject,
        renderedEmail,
      });
      const sent = { ...sentPrompt, approvalUrl, token: approval.token };
      toolsUsed.push(entry.ref);
      return {
        sections,
        draft,
        toolsUsed,
        emailApprovalSent: true,
        approvalRequest: sent,
        artifactBody,
      };
    }

    if (entry.ref === "internal.email_builder_render") {
      const document = assignment.config?.document;
      if (!document || typeof document !== "object") {
        throw new Error("Email builder render requires a document config");
      }
      const module = await import("./presets/newsletter-waypoint.js");
      const html = module.renderWaypointEmail(document as import("./presets/newsletter-waypoint.js").WaypointDocument);
      toolsUsed.push(entry.ref);
      sections.push(`Rendered email HTML (${html.length} bytes):\n${html.slice(0, 500)}${html.length > 500 ? "..." : ""}`);
      continue;
    }

    if (entry.ref === "internal.email_builder_compose") {
      toolsUsed.push(entry.ref);
      sections.push("Email builder compose tool is available. Use the UI to edit the email template.");
      continue;
    }

    if (entry.provider === "composio" && entry.requiresApproval) {
      const prepared = await completeText({
        system: `You prepare ${entry.label} content for human approval. Do not claim the external action happened.`,
        user: [`Goal: ${input.goal}`, `Task: ${input.agent.task}`, 'Return JSON: {"subject":"","body":"","recipient_email":""}'].join("\n"),
        maxTokens: 1200,
      });
      let payload: Record<string, unknown> = { raw: prepared };
      try { payload = JSON.parse(prepared) as Record<string, unknown>; } catch { payload = { body: prepared }; }
      toolsUsed.push(entry.ref);
      draft = buildDraftFromToolResults({ goal: input.goal, toolRef: entry.ref, toolResult: payload });
      sections.push(`Prepared ${entry.label} payload for approval:\n${JSON.stringify(payload, null, 2)}`);
    }
  }

  return { sections, draft, toolsUsed, emailApprovalSent: false as const };
}

/** Runs one agent: optional tools, then LLM synthesis unless a tool short-circuits. */
export async function runLoopAgent(input: RunLoopAgentInput): Promise<RunLoopAgentResult> {
  const bindCtx = {
    auth: input.auth,
    goal: input.goal,
    agentName: input.agent.name,
    agentTask: input.agent.task,
    priorComments: input.priorComments.map((c) => ({ author: c.author, body: c.body })),
    draftPolicy: input.draftPolicy,
  };
  const isNewsletterWriter = input.agent.id === "writer"
    && Boolean(input.definition && isNewsletterLoopDefinition(input.definition));
  const system = [
    buildAgentSystemPrompt(bindCtx),
    ...(isNewsletterWriter
      ? [
        "Writer output contract: line 1 must be `Subject: <title>` only.",
        "The body must not repeat that subject as a headline, H1, or opening sentence.",
        "Deliver polished subscriber copy only — no draft labels, handoffs, or workflow notes.",
      ]
      : []),
  ].join("\n");
  let user = buildAgentUserPrompt(bindCtx);
  let draft: unknown;
  let toolsUsed: string[] = [];

  if (!hasOnlyLlmTools(input.assignedTools)) {
    const toolRun = await runAssignedTools(input);
    toolsUsed = toolRun.toolsUsed;
    draft = toolRun.draft;
    if (toolRun.sections.length > 0) user = [user, "", ...toolRun.sections].join("\n");

    if (toolRun.toolsUsed.includes("internal.web_search")) {
      return {
        text: toolRun.sections.join("\n\n"),
        data: {
          model: "exa-search",
          mode: "tool_output_only",
          toolRefs: input.assignedTools.map((t) => t.ref),
          actionableToolRefs: actionableToolRefs(input.assignedTools),
          toolsUsed,
        },
        draft,
      };
    }

    if (toolRun.emailApprovalSent) {
      return {
        text: toolRun.sections.join("\n\n") || "Approval request sent.",
        data: { model: loopExecutorOpenAiModel(), mode: "tool_assisted", toolsUsed, emailApprovalSent: true },
        draft,
        emailApprovalSent: true,
        approvalRequest: toolRun.approvalRequest,
        artifactBody: toolRun.artifactBody,
      };
    }
  }

  const text = await completeText({ system, user, maxTokens: 1800 });
  return {
    text,
    data: {
      model: loopExecutorOpenAiModel(),
      mode: hasOnlyLlmTools(input.assignedTools) ? "llm_only" : "tool_assisted",
      toolRefs: input.assignedTools.map((t) => t.ref),
      actionableToolRefs: actionableToolRefs(input.assignedTools),
      toolsUsed,
    },
    draft,
  };
}

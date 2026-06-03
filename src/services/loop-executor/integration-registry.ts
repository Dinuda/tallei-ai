// @ts-nocheck
import { recallMemories } from "../memory.js";
import { config } from "../../config/index.js";
import { sendWorkflowRunApprovalPrompt, getPrimaryNotificationChannel } from "../channels.js";
import { createWorkflowApprovalRequest } from "../approval-tokens.js";
import { actionableToolRefs, buildAgentSystemPrompt, buildAgentUserPrompt, buildDraftFromToolResults, getLoopTool, hasOnlyLlmTools, } from "./tool-catalog.js";
import { extractNewsletterBodyFromComments } from "./publicist-email.js";
import { loopExecutorOpenAiChat, loopExecutorOpenAiModel } from "./openai-chat.js";
function readLoopAgentTimeoutMs() {
    const raw = process.env.TALLEI_LOOP_EXECUTOR__AGENT_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 5_000)
        return parsed;
    return 45_000;
}
async function withAbortTimeout(timeoutMs, fn, timeoutLabel) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fn(controller.signal);
    }
    catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
function readGatewaySearchConfig(raw) {
    const record = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : {};
    const domainsRaw = Array.isArray(record.allowedDomains)
        ? record.allowedDomains.filter((domain) => typeof domain === "string" && domain.trim().length > 0)
        : [];
    const contextSizeRaw = typeof record.searchContextSize === "string" ? record.searchContextSize : null;
    const countryRaw = typeof record.country === "string" ? record.country : null;
    const regionRaw = typeof record.region === "string" ? record.region : null;
    const cityRaw = typeof record.city === "string" ? record.city : null;
    const timezoneRaw = typeof record.timezone === "string" ? record.timezone : null;
    const contextSize = contextSizeRaw === "low" || contextSizeRaw === "medium" || contextSizeRaw === "high"
        ? contextSizeRaw
        : "medium";
    const country = countryRaw?.trim().toUpperCase() || "US";
    const region = regionRaw?.trim() || "California";
    const city = cityRaw?.trim() || "San Francisco";
    const timezone = timezoneRaw?.trim() || "America/Los_Angeles";
    return {
        allowedDomains: domainsRaw.slice(0, 20),
        contextSize,
        country,
        region,
        city,
        timezone,
    };
}
async function runExaWebSearch(input) {
    const searchConfig = readGatewaySearchConfig(input.config);
    const timeoutMs = readLoopAgentTimeoutMs();
    const exaApiKey = process.env.EXA_API_KEY?.trim() || "";
    if (!exaApiKey) {
        throw new Error("EXA_API_KEY is required for internal.web_search.");
    }
    const startPublishedDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const query = [
        input.task.trim(),
        "",
        `Goal context: ${input.goal.trim()}`,
        "Focus on current, high-signal developments from the last 7 days with reliable sources.",
    ].join("\n");
    const data = await withAbortTimeout(timeoutMs, async (signal) => {
        const response = await fetch("https://api.exa.ai/search", {
            method: "POST",
            signal,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": exaApiKey,
                "x-exa-integration": "tallei-loop-executor",
            },
            body: JSON.stringify({
                query,
                type: "auto",
                numResults: 8,
                userLocation: searchConfig.country,
                includeDomains: searchConfig.allowedDomains.length > 0 ? searchConfig.allowedDomains : undefined,
                startPublishedDate,
                contents: {
                    text: { maxCharacters: 1200 },
                    highlights: true,
                    summary: true,
                    livecrawl: "fallback",
                },
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Exa API error ${response.status}: ${body.slice(0, 500)}`);
        }
        return response.json();
    }, "Exa web search call");
    const resultsRaw = data && typeof data === "object" && Array.isArray(data.results)
        ? data.results
        : [];
    const results = resultsRaw
        .map((row) => {
        const record = row && typeof row === "object" ? row : {};
        const title = typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : "Untitled";
        const url = typeof record.url === "string" ? record.url.trim() : "";
        if (!url)
            return null;
        const publishedDate = typeof record.publishedDate === "string" ? record.publishedDate : null;
        const summary = typeof record.summary === "string" && record.summary.trim().length > 0
            ? record.summary.trim()
            : null;
        const highlights = Array.isArray(record.highlights)
            ? record.highlights.filter((v) => typeof v === "string" && v.trim().length > 0)
            : [];
        const text = typeof record.text === "string" ? record.text.trim() : "";
        const snippet = summary || highlights[0] || (text ? text.slice(0, 260) : "No snippet available.");
        return { title, url, publishedDate, snippet };
    })
        .filter((row) => row !== null);
    if (results.length === 0) {
        throw new Error("Exa returned no results for this query.");
    }
    const topThemes = results.slice(0, 4).map((row) => `- ${row.title}`);
    const evidence = results.slice(0, 8).map((row) => [
        `- ${row.title}${row.publishedDate ? ` (${row.publishedDate})` : ""}`,
        `  URL: ${row.url}`,
        `  Summary: ${row.snippet.replace(/\s+/g, " ").slice(0, 320)}`,
    ].join("\n"));
    const text = [
        "1) Top themes",
        ...topThemes,
        "",
        "2) Evidence with source URLs",
        ...evidence,
        "",
        "3) Suggested angles for the writer",
        "- Lead with the strongest new signal and why it matters now.",
        "- Compare at least two independent sources to avoid single-source bias.",
        "- Close with practical implications for product builders this week.",
    ].join("\n");
    return { text, model: "exa-search", provider: "exa_web_search" };
}
async function completeText(input) {
    const timeoutMs = readLoopAgentTimeoutMs();
    const response = await withAbortTimeout(timeoutMs, (signal) => loopExecutorOpenAiChat({
        messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
        ],
        temperature: 0.3,
        maxTokens: input.maxTokens ?? 1600,
        signal,
    }), "Loop agent model call");
    const text = response.text.trim();
    if (!text)
        throw new Error("Loop agent LLM returned an empty response");
    return text;
}
async function runAssignedTools(input) {
    const sections = [];
    const toolsUsed = [];
    let draft;
    for (const assignment of input.assignedTools) {
        const entry = getLoopTool(assignment.ref);
        if (!entry?.isActionable || entry.ref === "internal.llm_only")
            continue;
        if (entry.ref === "internal.memory_search") {
            const query = input.agent.task.slice(0, 500);
            const result = await recallMemories(query, input.auth, 5);
            toolsUsed.push(entry.ref);
            sections.push([
                "Memory search results:",
                ...result.memories.map((memory) => `- ${memory.text}`),
            ].join("\n"));
            continue;
        }
        if (entry.ref === "internal.web_search") {
            const result = await runExaWebSearch({
                goal: input.goal,
                task: input.agent.task,
                config: assignment.config,
            });
            toolsUsed.push(entry.ref);
            sections.push([
                `Web search results (${result.model} via Exa webSearch tool):`,
                result.text,
            ].join("\n"));
            continue;
        }
        if (entry.ref === "internal.email_approval_request") {
            if (!input.runId || !input.workflowId) {
                throw new Error("Email approval requires an active loop run context");
            }
            const artifactBody = extractNewsletterBodyFromComments(input.priorComments.map((comment) => ({ author: comment.author, body: comment.body })));
            if (!artifactBody.trim()) {
                throw new Error("Writer output is required before sending the approval email");
            }
            const primaryChannel = await getPrimaryNotificationChannel(input.auth);
            const approval = await createWorkflowApprovalRequest({
                auth: input.auth,
                targetType: "workflow_run",
                targetId: input.runId,
                channel: primaryChannel?.kind === "telegram" || primaryChannel?.kind === "gmail"
                    ? primaryChannel.kind
                    : "email",
            });
            const approvalUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/loops/approvals/${approval.token}/approve`;
            const sentPrompt = await sendWorkflowRunApprovalPrompt({
                auth: input.auth,
                runId: input.runId,
                workflowId: input.workflowId,
                workflowTitle: input.workflowTitle ?? "Newsletter",
                artifactBody,
                approvalUrl,
                approvalToken: approval.token,
                artifactKind: "draft",
            });
            const sent = {
                ...sentPrompt,
                approvalUrl,
                token: approval.token,
            };
            toolsUsed.push(entry.ref);
            sections.push([
                `Approval request sent via ${sent.channel ?? "email"} notification channel.`,
                `Recipient: ${sent.to}`,
                `Approval link issued at ${sent.sentAt}.`,
            ].join("\n"));
            return {
                sections,
                draft,
                toolsUsed,
                emailApprovalSent: true,
                approvalRequest: sent,
                artifactBody,
                publicistApproval: sent,
                newsletterBody: artifactBody,
            };
        }
        if (entry.provider === "composio" && entry.requiresApproval) {
            const prepared = await completeText({
                system: `You prepare ${entry.label} content for human approval. Do not claim the external action happened.`,
                user: [
                    `Goal: ${input.goal}`,
                    `Task: ${input.agent.task}`,
                    "Return JSON only with keys: subject, body, recipient_email (optional).",
                ].join("\n"),
                maxTokens: 1200,
            });
            let payload = { raw: prepared };
            try {
                payload = JSON.parse(prepared);
            }
            catch {
                payload = { body: prepared };
            }
            toolsUsed.push(entry.ref);
            draft = buildDraftFromToolResults({
                goal: input.goal,
                toolRef: entry.ref,
                toolResult: payload,
            });
            sections.push(`Prepared ${entry.label} payload for approval:\n${JSON.stringify(payload, null, 2)}`);
        }
    }
    return { sections, draft, toolsUsed };
}
export async function runLoopAgent(input) {
    const bindCtx = {
        auth: input.auth,
        goal: input.goal,
        agentName: input.agent.name,
        agentTask: input.agent.task,
        priorComments: input.priorComments.map((comment) => ({
            author: comment.author,
            body: comment.body,
        })),
        draftPolicy: input.draftPolicy,
    };
    const system = buildAgentSystemPrompt(bindCtx);
    let user = buildAgentUserPrompt(bindCtx);
    let draft;
    let toolsUsed = [];
    if (!hasOnlyLlmTools(input.assignedTools)) {
        const toolRun = await runAssignedTools(input);
        toolsUsed = toolRun.toolsUsed;
        draft = toolRun.draft;
        if (toolRun.sections.length > 0) {
            user = [user, "", ...toolRun.sections].join("\n");
        }
        if (toolRun.toolsUsed.includes("internal.web_search")) {
            return {
                text: toolRun.sections.join("\n\n"),
                data: {
                    model: "exa-search",
                    mode: "tool_output_only",
                    toolRefs: input.assignedTools.map((tool) => tool.ref),
                    actionableToolRefs: actionableToolRefs(input.assignedTools),
                    toolsUsed,
                    contextCommentCount: input.priorComments.length,
                },
                draft,
            };
        }
        if (toolRun.emailApprovalSent) {
            return {
                text: toolRun.sections.join("\n\n") || "Approval email sent.",
                data: {
                    model: loopExecutorOpenAiModel(),
                    mode: "tool_assisted",
                    toolRefs: input.assignedTools.map((tool) => tool.ref),
                    actionableToolRefs: actionableToolRefs(input.assignedTools),
                    toolsUsed,
                    contextCommentCount: input.priorComments.length,
                    emailApprovalSent: true,
                },
                draft,
                emailApprovalSent: true,
                approvalRequest: toolRun.approvalRequest,
                artifactBody: toolRun.artifactBody,
                publicistApproval: toolRun.publicistApproval,
                newsletterBody: toolRun.newsletterBody,
            };
        }
    }
    const text = await completeText({ system, user, maxTokens: 1800 });
    return {
        text,
        data: {
            model: loopExecutorOpenAiModel(),
            mode: hasOnlyLlmTools(input.assignedTools) ? "llm_only" : "tool_assisted",
            toolRefs: input.assignedTools.map((tool) => tool.ref),
            actionableToolRefs: actionableToolRefs(input.assignedTools),
            toolsUsed,
            contextCommentCount: input.priorComments.length,
        },
        draft,
    };
}
//# sourceMappingURL=integration-registry.js.map

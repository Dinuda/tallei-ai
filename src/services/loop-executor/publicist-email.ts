// @ts-nocheck
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { sendResendEmail } from "../notifications/resend-email.js";
import { consumeWorkflowApprovalToken, createWorkflowApprovalRequest, resolveWorkflowApprovalToken, } from "../workflow-automation.js";
function cleanDisplayMarkdown(value) {
    return value
        .trim()
        .replace(/(^|[\s(])(\*\*|__)(?=\S)/g, "$1")
        .replace(/(?<=\S)(\*\*|__)(?=([\s).,!?:;]|$))/g, "");
}
function loopRunPageUrl(workflowId, runId) {
    const base = config.frontendUrl.replace(/\/$/, "");
    return `${base}/dashboard/loops/${workflowId}/runs/${runId}`;
}
async function resolvePrimaryEmailDestination(auth) {
    const result = await pool.query(`SELECT destination
     FROM notification_channels
     WHERE tenant_id = $1
       AND user_id = $2
       AND enabled = TRUE
       AND kind = 'email'
     ORDER BY created_at ASC
     LIMIT 1`, [auth.tenantId, auth.userId]);
    const destination = result.rows[0]?.destination?.trim();
    return destination && destination.length > 0 ? destination : null;
}
export function extractNewsletterBodyFromComments(comments) {
    const writer = comments.find((comment) => /^writer$/i.test(comment.author.trim()));
    if (writer?.body?.trim())
        return sanitizeSubscriberNewsletterBody(writer.body);
    const publicist = comments.find((comment) => /^publicist$/i.test(comment.author.trim()));
    if (publicist?.body?.trim())
        return sanitizeSubscriberNewsletterBody(publicist.body);
    return sanitizeSubscriberNewsletterBody(comments.at(-1)?.body?.trim() ?? "");
}
function escapeHtml(value) {
    return value.replace(/[<>&"]/g, (char) => ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "\"": "&quot;",
    }[char] ?? char));
}
function formatInlineMarkdown(value) {
    const linkTokens = [];
    const codeTokens = [];
    const withLinkTokens = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
        const token = `__MD_LINK_${linkTokens.length}__`;
        linkTokens.push(`<a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(label)}</a>`);
        return token;
    });
    const withCodeTokens = withLinkTokens.replace(/`([^`]+)`/g, (_, content) => {
        const token = `__MD_CODE_${codeTokens.length}__`;
        codeTokens.push(`<code style="background:#f3f4f6;border-radius:6px;padding:1px 6px;color:#111827;">${escapeHtml(content)}</code>`);
        return token;
    });
    let formatted = escapeHtml(withCodeTokens)
        .replace(/(https?:\/\/[^\s<]+)/g, (match) => `<a href="${match}" style="color:#2563eb;text-decoration:underline;">${match}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    for (let index = 0; index < linkTokens.length; index += 1) {
        formatted = formatted.replace(`__MD_LINK_${index}__`, linkTokens[index] ?? "");
    }
    for (let index = 0; index < codeTokens.length; index += 1) {
        formatted = formatted.replace(`__MD_CODE_${index}__`, codeTokens[index] ?? "");
    }
    return formatted;
}
function removeUnsupportedCtaPhrases(value) {
    return value
        .replace(/\s+(?:Read more here|Explore the details)\.?(?=\s|$)/gi, "")
        .replace(/\n{3,}/g, "\n\n");
}
export function sanitizeSubscriberNewsletterBody(raw) {
    const normalized = raw
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!normalized)
        return "";
    const firstInternalCueIndex = [
        /please review this draft\b/i,
        /let me know if you would like any changes\b/i,
        /before we proceed to the publicist\b/i,
        /would you like to make any adjustments\b/i,
        /add specific sections before we proceed\b/i,
        /approve (?:this|the) draft\b/i,
        /do not send to subscribers until\b/i,
        /upload a csv\b/i,
        /contact list upload\b/i,
    ]
        .map((pattern) => normalized.search(pattern))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
    const stopPatterns = [
        /^#{1,6}\s*operator approval email\b/im,
        /^#{1,6}\s*approval email\b/im,
        /^#{1,6}\s*next steps\b/im,
        /^#{1,6}\s*internal notes?\b/im,
        /^#{1,6}\s*operator approval\b/im,
        /^#{1,6}\s*contact list\b/im,
        /^#{1,6}\s*end of loop output\b/im,
        /^\*\*end of loop output\*\*/im,
    ];
    const cutAt = stopPatterns
        .map((pattern) => normalized.search(pattern))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
    const boundary = [cutAt, firstInternalCueIndex]
        .filter((value) => typeof value === "number" && value >= 0)
        .sort((a, b) => a - b)[0];
    const publicSection = (boundary >= 0 ? normalized.slice(0, boundary) : normalized).trim();
    const lines = publicSection.split("\n");
    const cleaned = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^\[?insert newsletter draft here\]?$/i.test(trimmed.replace(/\*/g, "")))
            continue;
        if (/^(?:#{1,6}\s*)?draft newsletter(?:\s+in\s+.+)?$/i.test(trimmed.replace(/\*/g, "")))
            continue;
        if (/^(?:#{1,6}\s*)?newsletter draft$/i.test(trimmed.replace(/\*/g, "")))
            continue;
        if (/^the draft for .+ newsletter .+ is ready\.?\s*(?:here it is:?)?$/i.test(trimmed))
            continue;
        if (/^here (?:it is|is the draft):?$/i.test(trimmed))
            continue;
        if (/\[operator'?s name\]/i.test(trimmed))
            continue;
        if (/^once approved\b/i.test(trimmed))
            continue;
        if (/^please review\b/i.test(trimmed) && /approve|distribution/i.test(trimmed))
            continue;
        if (/^would you like\b/i.test(trimmed) && /adjustments?|proceed|next step/i.test(trimmed))
            continue;
        cleaned.push(line);
    }
    return removeUnsupportedCtaPhrases(cleaned
        .join("\n")
        .replace(/\n\s*---\s*$/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim());
}
export function formatNewsletterForEmail(raw) {
    const sanitized = sanitizeSubscriberNewsletterBody(raw);
    const lines = sanitized.split("\n");
    let subject = null;
    const bodyLines = [];
    for (const line of lines) {
        const subjectMatch = line.trim().match(/^(?:\*\*)?subject:?(?:\*\*)?\s*(.+)$/i);
        if (!subject && subjectMatch?.[1]) {
            subject = cleanDisplayMarkdown(subjectMatch[1].replace(/^["']|["']$/g, "").trim());
            continue;
        }
        if (/^!\[[^\]]*]\([^)]+\)$/.test(line.trim()))
            continue;
        bodyLines.push(line);
    }
    const text = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    const htmlBlocks = blocks.map((block) => {
        if (/^[-*_]{3,}$/.test(block.replace(/\s/g, ""))) {
            return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 28px;">';
        }
        if (/^#{1,6}\s+/.test(block)) {
            const markdownLevel = block.match(/^#+/)?.[0].length ?? 2;
            const level = Math.min(3, Math.max(1, markdownLevel));
            const headingText = formatInlineMarkdown(block.replace(/^#{1,6}\s+/, ""));
            if (level === 1) {
                return `<h1 style="margin:0 0 20px;font-size:34px;line-height:1.16;letter-spacing:-0.02em;color:#111827;font-weight:800;">${headingText}</h1>`;
            }
            if (level === 2) {
                return `<h2 style="margin:28px 0 14px;font-size:24px;line-height:1.26;letter-spacing:-0.01em;color:#111827;font-weight:700;">${headingText}</h2>`;
            }
            return `<h3 style="margin:24px 0 12px;font-size:19px;line-height:1.35;color:#111827;font-weight:700;">${headingText}</h3>`;
        }
        const linesInBlock = block.split("\n").map((line) => line.trim()).filter(Boolean);
        if (linesInBlock.every((line) => /^[-*]\s+/.test(line))) {
            const items = linesInBlock
                .map((line) => `<li style="margin:0 0 10px;">${formatInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`)
                .join("");
            return `<ul style="margin:0 0 18px;padding:0 0 0 22px;">${items}</ul>`;
        }
        if (linesInBlock.every((line) => /^\d+\.\s+/.test(line))) {
            const items = linesInBlock
                .map((line) => `<li style="margin:0 0 10px;">${formatInlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`)
                .join("");
            return `<ol style="margin:0 0 18px;padding:0 0 0 24px;">${items}</ol>`;
        }
        if (linesInBlock.every((line) => /^>\s?/.test(line))) {
            const quote = linesInBlock.map((line) => formatInlineMarkdown(line.replace(/^>\s?/, ""))).join("<br>");
            return `<blockquote style="margin:0 0 20px;padding:14px 16px;border-left:4px solid #cbd5e1;background:#f8fafc;color:#334155;">${quote}</blockquote>`;
        }
        if (/^(blog|further reading|resources|links):\s*$/i.test(linesInBlock[0] ?? "")) {
            const heading = formatInlineMarkdown((linesInBlock[0] ?? "").replace(/:\s*$/, ""));
            const content = linesInBlock
                .slice(1)
                .map((line) => formatInlineMarkdown(line))
                .join("<br>");
            return [
                '<div style="margin:22px 0 24px;padding:18px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">',
                `<p style="margin:0 0 8px;font-size:15px;line-height:1.4;color:#111827;font-weight:700;">${heading}</p>`,
                `<p style="margin:0;font-size:16px;line-height:1.62;color:#111827;">${content}</p>`,
                "</div>",
            ].join("");
        }
        return `<p style="margin:0 0 18px;font-size:20px;line-height:1.68;color:#1f2937;">${formatInlineMarkdown(block).replace(/\n/g, "<br>")}</p>`;
    });
    const html = [
        '<div style="margin:0;padding:28px 0 20px;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 100%);">',
        '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Arial,sans-serif;line-height:1.6;color:#111827;max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dbe4ff;border-radius:24px;overflow:hidden;box-shadow:0 24px 60px rgba(37,99,235,0.10);">',
        '<div style="margin:28px 34px 0;padding:22px 24px 20px;border-radius:20px;background:radial-gradient(circle at top left,#1d4ed8 0%,#0f172a 72%);">',
        subject
            ? `<h1 style="margin:0;font-size:40px;line-height:1.08;letter-spacing:-0.03em;color:#ffffff;font-weight:800;">${formatInlineMarkdown(subject)}</h1>
         <p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:#dbeafe;max-width:560px;">Sharp ideas, product lessons, and signal worth paying attention to this week.</p>`
            : "",
        "</div>",
        '<div style="padding:32px 34px 34px;">',
        htmlBlocks.join("\n"),
        '<div style="margin:30px 0 0;padding:18px 20px;border-radius:18px;background:#f8fafc;border:1px solid #e2e8f0;">',
        '<p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">Sent by Tallei. Built for readers who want concise product thinking without the filler.</p>',
        "</div>",
        "</div>",
        "</div>",
        "</div>",
    ].join("\n");
    return { subject, text, html };
}
/** Wrap newsletter HTML for Resend Broadcasts (contact properties + unsubscribe). */
export function formatNewsletterForBroadcast(formatted) {
    const html = [
        '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">This week\'s Tallei brief: practical product insights, sharper signals, and links worth your time.</div>',
        '<div style="margin:0;padding:28px 0 44px;background:linear-gradient(180deg,#e0f2fe 0%,#eef2ff 48%,#f8fafc 100%);">',
        '<div style="max-width:780px;margin:0 auto;padding:0 16px;">',
        '<div style="padding:0 8px 18px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Arial,sans-serif;">',
        '<p style="margin:0;font-size:18px;line-height:1.5;color:#0f172a;">Hi {{{contact.first_name|there}}},</p>',
        "</div>",
        formatted.html,
        '<div style="padding:20px 8px 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Arial,sans-serif;">',
        '<div style="padding:16px 18px;border-top:1px solid #cbd5e1;">',
        '<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">You’re receiving this because you subscribed to updates from Tallei.</p>',
        '<p style="margin:10px 0 0;font-size:14px;line-height:1.5;color:#64748b;">',
        '<a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#475569;text-decoration:underline;">Unsubscribe</a>',
        "</p>",
        "</div>",
        "</div>",
        "</div>",
        "</div>",
    ].join("\n");
    const text = [
        "Hi {{{contact.first_name|there}}},",
        "",
        formatted.text,
        "",
        "You’re receiving this because you subscribed to updates from Tallei.",
        "",
        "Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}",
    ].join("\n");
    return { html, text };
}
export async function sendRunApprovalEmail(input) {
    const to = await resolvePrimaryEmailDestination(input.auth);
    if (!to) {
        throw new Error("No enabled email notification channel found. Add an email destination in notification settings.");
    }
    const approval = await createWorkflowApprovalRequest({
        auth: input.auth,
        targetType: "workflow_run",
        targetId: input.runId,
        channel: "email",
    });
    const approveUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/loops/approvals/${approval.token}/approve`;
    const runUrl = loopRunPageUrl(input.workflowId, input.runId);
    const artifactKind = input.artifactKind?.trim() || "draft";
    const subject = `Approval required: ${input.workflowTitle}`;
    const formatted = formatNewsletterForEmail(input.artifactBody);
    const preview = formatted.text.slice(0, 4000);
    const text = [
        `Your ${artifactKind} is ready for review.`,
        "",
        preview,
        "",
        `Approve this draft: ${approveUrl}`,
        "",
        `Or open the run in Tallei: ${runUrl}`,
    ].join("\n");
    const html = [
        `<p>Your ${escapeHtml(artifactKind)} is ready for review.</p>`,
        formatted.html,
        `<p><a href="${approveUrl}">Approve this draft</a></p>`,
        `<p><a href="${runUrl}">Open run in Tallei</a></p>`,
    ].join("");
    const result = await sendResendEmail({ to, subject, text, html, auth: input.auth });
    if (!result.ok) {
        throw new Error(result.error ?? "Failed to send approval email");
    }
    return {
        to,
        approvalUrl: approveUrl,
        token: approval.token,
        sentAt: new Date().toISOString(),
    };
}
export async function sendRunInputPromptEmail(input) {
    const runUrl = loopRunPageUrl(input.workflowId, input.runId);
    const subject = `Input needed: ${input.workflowTitle}`;
    const inputLabel = input.inputLabel?.trim() || "required input";
    const instructions = input.instructions?.trim()
        || "Upload a CSV contact list (columns: email, name) to continue this run.";
    const text = [
        "Thanks — this run is approved.",
        "",
        `${inputLabel}:`,
        instructions,
        runUrl,
    ].join("\n");
    const html = [
        "<p>Thanks — this run is approved.</p>",
        `<p><strong>${escapeHtml(inputLabel)}</strong></p>`,
        `<p>${escapeHtml(instructions)}</p>`,
        `<p><a href="${runUrl}">${runUrl}</a></p>`,
    ].join("");
    const result = await sendResendEmail({
        to: input.to,
        subject,
        text,
        html,
        auth: input.auth,
    });
    if (!result.ok) {
        throw new Error(result.error ?? "Failed to send run input prompt");
    }
}
export function parseContactListCsv(csv) {
    const lines = csv.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0)
        return [];
    const splitRow = (line) => {
        if (line.includes(",") && !line.includes("\t")) {
            return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
        }
        if (line.includes("\t"))
            return line.split("\t").map((cell) => cell.trim());
        if (line.includes(";"))
            return line.split(";").map((cell) => cell.trim());
        return [line.trim()];
    };
    const header = splitRow(lines[0]).map((cell) => cell.toLowerCase());
    const emailIdx = header.findIndex((cell) => cell === "email" || cell === "email_address");
    const nameIdx = header.findIndex((cell) => cell === "name" || cell === "full_name");
    const dataLines = emailIdx >= 0 ? lines.slice(1) : lines;
    const effectiveEmailIdx = emailIdx >= 0 ? emailIdx : 0;
    const contacts = [];
    const seen = new Set();
    for (const line of dataLines) {
        const cells = splitRow(line);
        const email = cells[effectiveEmailIdx]?.trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            continue;
        if (seen.has(email))
            continue;
        seen.add(email);
        const name = nameIdx >= 0 ? cells[nameIdx]?.trim() : undefined;
        contacts.push({ email, ...(name ? { name } : {}) });
    }
    if (contacts.length === 0) {
        throw new Error("Contact list CSV must include at least one valid email address");
    }
    return contacts.slice(0, 5000);
}
async function approveLoopRunForContactUpload(input) {
    const runResult = await pool.query(`SELECT id, workflow_id, status, metadata_json
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`, [input.runId, input.tenantId, input.userId]);
    const run = runResult.rows[0];
    if (!run)
        throw new Error("Workflow run not found");
    const meta = run.metadata_json && typeof run.metadata_json === "object"
        ? run.metadata_json
        : {};
    const loopExecutor = meta.loop_executor && typeof meta.loop_executor === "object"
        ? meta.loop_executor
        : {};
    const approvalRequest = loopExecutor.approvalRequest && typeof loopExecutor.approvalRequest === "object"
        ? loopExecutor.approvalRequest
        : loopExecutor.publicistApproval && typeof loopExecutor.publicistApproval === "object"
            ? loopExecutor.publicistApproval
            : {};
    const to = typeof approvalRequest.to === "string" ? approvalRequest.to : null;
    const hasApprovalContext = typeof approvalRequest.token === "string"
        || typeof approvalRequest.approvalUrl === "string"
        || typeof approvalRequest.sentAt === "string";
    if (!hasApprovalContext && input.approvedBy !== "email") {
        throw new Error("Run has no loop approval context to continue");
    }
    const canApproveFromStatus = run.status === "waiting_for_approval" || run.status === "waiting_for_email_approval" || run.status === "blocked";
    if (!canApproveFromStatus) {
        if (run.status === "waiting_for_contact_list" || run.status === "waiting_for_input" || run.status === "executing_action" || run.status === "distributing" || run.status === "completed") {
            return {
                runId: run.id,
                workflowId: run.workflow_id,
                status: run.status,
                contactPromptEmail: to,
                workflowTitle: "Newsletter",
            };
        }
        throw new Error(`Run is ${run.status}, not waiting for approval`);
    }
    const workflowResult = await pool.query(`SELECT title FROM workflows WHERE id = $1 LIMIT 1`, [run.workflow_id]);
    const workflowTitle = workflowResult.rows[0]?.title ?? "Newsletter";
    const resolvedEmailDestination = to ?? await resolvePrimaryEmailDestination({
        tenantId: input.tenantId,
        userId: input.userId,
        authMode: "internal",
        plan: "pro",
    });
    const approvedAt = new Date().toISOString();
    await pool.query(`UPDATE workflow_runs
     SET status = 'waiting_for_contact_list',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        run.id,
        input.tenantId,
        input.userId,
        JSON.stringify({
            loop_executor: {
                ...loopExecutor,
                emailApprovedAt: approvedAt,
                approvalChannel: input.approvedBy,
                approvalDecision: {
                    approvedAt,
                    channel: input.approvedBy,
                },
                pendingInput: {
                    id: "recipient_list_csv",
                    kind: "csv",
                    label: "Recipient list CSV",
                    status: "pending",
                    requestedAt: approvedAt,
                    instructions: "Upload a CSV with `email` and optional `name` columns. The newsletter sends immediately when you upload — no further approval.",
                    schema: {
                        requiredColumns: ["email"],
                        optionalColumns: ["name"],
                        maxRows: 5000,
                    },
                },
                ...(input.approvedBy === "ui" ? { uiApprovedAt: approvedAt } : {}),
            },
        }),
    ]);
    return {
        runId: run.id,
        workflowId: run.workflow_id,
        status: "waiting_for_contact_list",
        contactPromptEmail: resolvedEmailDestination,
        workflowTitle,
    };
}
/** Apply draft approval metadata when upload arrives before a separate approve click. */
export async function ensureDraftApprovedForContactUpload(input) {
    const runResult = await pool.query(`SELECT status, metadata_json
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`, [input.runId, input.tenantId, input.userId]);
    const run = runResult.rows[0];
    if (!run)
        throw new Error("Workflow run not found");
    if (run.status !== "waiting_for_approval" && run.status !== "waiting_for_email_approval") {
        return false;
    }
    await approveLoopRunForContactUpload({
        tenantId: input.tenantId,
        userId: input.userId,
        runId: input.runId,
        approvedBy: "csv_upload",
    });
    return true;
}
export async function approveLoopRunFromUi(input) {
    const approved = await approveLoopRunForContactUpload({
        tenantId: input.auth.tenantId,
        userId: input.auth.userId,
        runId: input.runId,
        approvedBy: "ui",
    });
    return {
        runId: approved.runId,
        workflowId: approved.workflowId,
        status: approved.status,
    };
}
export async function approveLoopRunFromEmailToken(token) {
    const resolved = await resolveWorkflowApprovalToken(token);
    if (!resolved)
        throw new Error("Approval token not found");
    if (resolved.expired)
        throw new Error("Approval token expired");
    if (resolved.consumedAt)
        throw new Error("Approval token already used");
    if (resolved.targetType !== "workflow_run")
        throw new Error("Invalid approval target");
    const approved = await approveLoopRunForContactUpload({
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        runId: resolved.targetId,
        approvedBy: "email",
    });
    await consumeWorkflowApprovalToken(token);
    return {
        runId: approved.runId,
        workflowId: approved.workflowId,
        status: approved.status,
    };
}
export const sendPublicistApprovalEmail = sendRunApprovalEmail;
export const sendContactListUploadPromptEmail = sendRunInputPromptEmail;
export const approveLoopRunApprovalToken = approveLoopRunFromEmailToken;
//# sourceMappingURL=publicist-email.js.map

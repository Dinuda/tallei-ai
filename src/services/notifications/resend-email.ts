// @ts-nocheck
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";

const RESEND_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;
function dryRunId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}
async function resolveConnectorResendCredentials(auth) {
    const result = await pool.query(`SELECT metadata_json
     FROM connector_accounts
     WHERE tenant_id = $1
       AND user_id = $2
       AND provider = 'resend'
       AND status = 'connected'
     ORDER BY updated_at DESC
     LIMIT 1`, [auth.tenantId, auth.userId]);
    const row = result.rows[0];
    if (!row)
        return null;
    const metadata = row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
        ? row.metadata_json
        : {};
    const ciphertext = typeof metadata.apiKeyCiphertext === "string" ? metadata.apiKeyCiphertext : null;
    if (!ciphertext)
        return null;
    let apiKey = "";
    try {
        apiKey = decryptMemoryContent(ciphertext).trim();
    }
    catch {
        apiKey = "";
    }
    if (!apiKey)
        return null;
    const fromEmail = typeof metadata.fromEmail === "string" && metadata.fromEmail.trim()
        ? metadata.fromEmail.trim()
        : config.signupEmailFromEmail;
    if (!fromEmail)
        return null;
    const fromName = typeof metadata.fromName === "string" && metadata.fromName.trim()
        ? metadata.fromName.trim()
        : (config.signupEmailFromName || "Tallei");
    const replyTo = typeof metadata.replyTo === "string" && metadata.replyTo.trim()
        ? metadata.replyTo.trim()
        : (config.signupEmailReplyTo || undefined);
    return { apiKey, fromEmail, fromName, replyTo };
}
export async function resolveResendCredentials(auth) {
    if (auth) {
        const connectorCreds = await resolveConnectorResendCredentials(auth);
        if (connectorCreds)
            return connectorCreds;
    }
    if (!config.signupResendApiKey || !config.signupEmailFromEmail)
        return null;
    return {
        apiKey: config.signupResendApiKey,
        fromEmail: config.signupEmailFromEmail,
        fromName: config.signupEmailFromName || "Tallei",
        replyTo: config.signupEmailReplyTo || undefined,
    };
}
async function postJson(url, payload, headers, method = "POST") {
    const hasBody = method !== "GET" && method !== "DELETE";
    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(headers ?? {}),
        },
        body: hasBody ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, responseText };
}
export function formatResendFromAddress(creds) {
    return `${creds.fromName} <${creds.fromEmail}>`;
}
export async function resendApiRequest(input) {
    const method = input.method ?? "POST";
    const url = `https://api.resend.com${input.path.startsWith("/") ? input.path : `/${input.path}`}`;
    try {
        const result = await postJson(url, input.body ?? {}, { Authorization: `Bearer ${input.creds.apiKey}` }, method);
        let data;
        if (result.responseText) {
            try {
                const parsed = JSON.parse(result.responseText);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    data = parsed;
                }
            }
            catch {
                data = undefined;
            }
        }
        if (!result.ok) {
            const message = typeof data?.message === "string"
                ? data.message
                : result.responseText || `Resend API returned ${result.status}`;
            return { ok: false, status: result.status, error: message };
        }
        return { ok: true, status: result.status, data };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Unknown Resend API error",
        };
    }
}
async function postJsonEmail(url, payload, headers) {
    return postJson(url, payload, headers, "POST");
}
export async function sendResendEmail(input) {
    if (!config.notificationsOutboundEmailEnabled) {
        console.info(`[notifications] outbound email dry-run: ${input.subject} -> ${input.to}`);
        return { ok: true, status: 202, id: dryRunId("dry_email") };
    }
    const creds = await resolveResendCredentials(input.auth);
    if (!creds) {
        return {
            ok: false,
            error: "Resend is not configured. Set signup Resend environment variables before sending email.",
        };
    }
    const from = formatResendFromAddress(creds);
    const replyTo = input.replyTo ?? creds.replyTo;
    try {
        const result = await postJsonEmail(RESEND_URL, {
            from,
            to: [input.to],
            subject: input.subject,
            text: input.text,
            html: input.html,
            reply_to: replyTo,
        }, {
            Authorization: `Bearer ${creds.apiKey}`,
        });
        if (!result.ok) {
            return {
                ok: false,
                status: result.status,
                error: `Webhook returned ${result.status}${result.responseText ? `: ${result.responseText}` : ""}`,
            };
        }
        let id;
        try {
            const body = JSON.parse(result.responseText);
            id = typeof body.id === "string" ? body.id : undefined;
        }
        catch {
            id = undefined;
        }
        return { ok: true, status: result.status, id };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Unknown webhook error",
        };
    }
}
//# sourceMappingURL=resend-email.js.map

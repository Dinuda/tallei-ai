// @ts-nocheck
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { encryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { formatResendFromAddress, resendApiRequest, resolveResendCredentials, } from "./resend-email.js";

let resendRequestQueue = Promise.resolve();
let lastResendRequestAt = 0;
const METRICS_WEBHOOK_EVENTS = [
    "email.sent",
    "email.delivered",
    "email.opened",
    "email.clicked",
    "email.bounced",
    "email.failed",
    "email.complained",
    "email.delivery_delayed",
    "email.suppressed",
];
const GMAIL_CLIPPING_WARNING_BYTES = 95_000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function paceResendRequest() {
    const previous = resendRequestQueue;
    let release = () => undefined;
    resendRequestQueue = new Promise((resolve) => {
        release = resolve;
    });
    await previous.catch(() => undefined);
    const elapsed = Date.now() - lastResendRequestAt;
    const waitMs = Math.max(0, 650 - elapsed);
    if (waitMs > 0) {
        await sleep(waitMs);
    }
    lastResendRequestAt = Date.now();
    release();
}
function splitContactName(name) {
    const trimmed = name?.trim();
    if (!trimmed)
        return {};
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1)
        return { firstName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
function encodeContactEmail(email) {
    return encodeURIComponent(email.trim().toLowerCase());
}
function isSegmentLimitError(error) {
    return /segments?|upgrade|plan/i.test(error ?? "");
}
function isRateLimitResult(result) {
    return result?.status === 429 || /too many requests|rate limit/i.test(result?.error ?? "");
}
async function callResendApi(input) {
    let latest = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await paceResendRequest();
        latest = await resendApiRequest(input);
        if (!isRateLimitResult(latest)) {
            return latest;
        }
        await sleep(1250 * (attempt + 1));
    }
    return latest ?? { ok: false, error: "Resend API request failed" };
}
function readSegments(data) {
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
        .map((row) => row && typeof row === "object" ? row : {})
        .map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        name: typeof row.name === "string" ? row.name : "",
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
    }))
        .filter((row) => row.id && row.name);
}
function metricsWebhookEndpoint() {
    return `${config.publicBaseUrl.replace(/\/$/, "")}/api/channels/webhooks/resend-events`;
}
function normalizeEvents(events) {
    return Array.isArray(events) ? events.filter((event) => typeof event === "string") : [];
}
function hasAllMetricsEvents(events) {
    const set = new Set(normalizeEvents(events));
    return METRICS_WEBHOOK_EVENTS.every((event) => set.has(event));
}
async function updateResendWebhookMetadata(input) {
    const metadata = {
        resendMetricsWebhook: {
            id: input.webhookId,
            endpoint: input.endpoint,
            events: METRICS_WEBHOOK_EVENTS,
            ensuredAt: new Date().toISOString(),
            ...(input.signingSecret
                ? { signingSecretCiphertext: encryptMemoryContent(input.signingSecret) }
                : {}),
        },
    };
    await pool.query(`UPDATE connector_accounts
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2
       AND provider = 'resend'
       AND status = 'connected'
       AND metadata_json->>'apiKeyCiphertext' IS NOT NULL`, [
        input.auth.tenantId,
        input.auth.userId,
        JSON.stringify(metadata),
    ]);
}
async function reclaimOldTalleiSegment(creds) {
    const listed = await callResendApi({
        creds,
        method: "GET",
        path: "/segments",
    });
    if (!listed.ok) {
        return { ok: false, error: listed.error ?? "Failed to list Resend segments" };
    }
    const reusable = readSegments(listed.data)
        .filter((segment) => /^Tallei\b/i.test(segment.name))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!reusable) {
        return { ok: false, error: "Resend segment limit reached and no old Tallei segment is available to reclaim" };
    }
    const deleted = await callResendApi({
        creds,
        method: "DELETE",
        path: `/segments/${encodeURIComponent(reusable.id)}`,
    });
    if (!deleted.ok) {
        return { ok: false, error: deleted.error ?? `Failed to delete old Resend segment ${reusable.id}` };
    }
    return { ok: true, deletedSegmentId: reusable.id };
}
async function createResendSegmentOnce(input) {
    const result = await callResendApi({
        creds: input.creds,
        path: "/segments",
        body: { name: input.name.slice(0, 120) },
    });
    const segmentId = typeof result.data?.id === "string" ? result.data.id : undefined;
    if (!result.ok || !segmentId) {
        return { ok: false, error: result.error ?? "Failed to create Resend segment" };
    }
    return { ok: true, segmentId };
}
export async function createResendSegment(input) {
    const created = await createResendSegmentOnce(input);
    if (created.ok || !isSegmentLimitError(created.error)) {
        return created;
    }
    const reclaimed = await reclaimOldTalleiSegment(input.creds);
    if (!reclaimed.ok) {
        return { ok: false, error: `${created.error}; ${reclaimed.error}` };
    }
    return createResendSegmentOnce(input);
}
export async function upsertResendContactInSegment(input) {
    const email = input.contact.email.trim().toLowerCase();
    const { firstName, lastName } = splitContactName(input.contact.name);
    const createBody = {
        email,
        unsubscribed: false,
        segments: [{ id: input.segmentId }],
    };
    if (firstName)
        createBody.first_name = firstName;
    if (lastName)
        createBody.last_name = lastName;
    const created = await callResendApi({
        creds: input.creds,
        path: "/contacts",
        body: createBody,
    });
    if (created.ok) {
        const contactId = typeof created.data?.id === "string" ? created.data.id : undefined;
        return { email, ok: true, status: created.status, contactId };
    }
    const addToSegment = await callResendApi({
        creds: input.creds,
        method: "POST",
        path: `/contacts/${encodeContactEmail(email)}/segments/${input.segmentId}`,
        body: {},
    });
    if (addToSegment.ok) {
        return { email, ok: true, status: addToSegment.status };
    }
    return {
        email,
        ok: false,
        status: addToSegment.status ?? created.status,
        error: addToSegment.error ?? created.error ?? "Failed to sync contact to segment",
    };
}
export async function createAndSendResendBroadcast(input) {
    const htmlBytes = Buffer.byteLength(input.html ?? "", "utf8");
    const textBytes = Buffer.byteLength(input.text ?? "", "utf8");
    const result = await callResendApi({
        creds: input.creds,
        path: "/broadcasts",
        body: {
            segment_id: input.segmentId,
            from: formatResendFromAddress(input.creds),
            subject: input.subject,
            html: input.html,
            text: input.text,
            name: input.name.slice(0, 120),
            send: true,
        },
    });
    const broadcastId = typeof result.data?.id === "string" ? result.data.id : undefined;
    if (!result.ok || !broadcastId) {
        return {
            ok: false,
            status: result.status,
            error: result.error ?? "Failed to create Resend broadcast",
        };
    }
    return {
        ok: true,
        broadcastId,
        segmentId: input.segmentId,
        status: result.status,
        dryRun: result.dryRun === true,
        htmlBytes,
        textBytes,
        gmailClippingRisk: htmlBytes >= GMAIL_CLIPPING_WARNING_BYTES,
    };
}
export async function resolveResendMarketingCredentials(auth) {
    return resolveResendCredentials(auth);
}
export async function ensureResendMetricsWebhook(input) {
    const endpoint = metricsWebhookEndpoint();
    if (!/^https:\/\//i.test(endpoint)) {
        return {
            ok: false,
            error: "Resend metrics webhook requires TALLEI_HTTP__PUBLIC_BASE_URL to be a public HTTPS URL.",
        };
    }
    const listed = await callResendApi({
        creds: input.creds,
        method: "GET",
        path: "/webhooks",
    });
    if (!listed.ok) {
        return {
            ok: false,
            status: listed.status,
            error: listed.error ?? "Failed to list Resend webhooks. Use a Resend API key with full access.",
        };
    }
    const webhooks = Array.isArray(listed.data?.data) ? listed.data.data : [];
    const existing = webhooks.find((webhook) => {
        if (!webhook || typeof webhook !== "object")
            return false;
        return webhook.endpoint === endpoint && webhook.status !== "disabled" && hasAllMetricsEvents(webhook.events);
    });
    if (existing?.id) {
        await updateResendWebhookMetadata({
            auth: input.auth,
            webhookId: existing.id,
            endpoint,
        });
        return { ok: true, webhookId: existing.id, endpoint, events: METRICS_WEBHOOK_EVENTS, created: false };
    }
    const sameEndpoint = webhooks.find((webhook) => {
        if (!webhook || typeof webhook !== "object")
            return false;
        return webhook.endpoint === endpoint && typeof webhook.id === "string";
    });
    if (sameEndpoint?.id) {
        const updated = await callResendApi({
            creds: input.creds,
            method: "PATCH",
            path: `/webhooks/${encodeURIComponent(sameEndpoint.id)}`,
            body: {
                endpoint,
                events: METRICS_WEBHOOK_EVENTS,
                status: "enabled",
            },
        });
        if (!updated.ok) {
            return {
                ok: false,
                status: updated.status,
                error: updated.error ?? "Failed to update Resend metrics webhook event subscriptions.",
            };
        }
        const fetched = await callResendApi({
            creds: input.creds,
            method: "GET",
            path: `/webhooks/${encodeURIComponent(sameEndpoint.id)}`,
        });
        const signingSecret = typeof fetched.data?.signing_secret === "string" ? fetched.data.signing_secret : undefined;
        await updateResendWebhookMetadata({
            auth: input.auth,
            webhookId: sameEndpoint.id,
            endpoint,
            signingSecret,
        });
        return { ok: true, webhookId: sameEndpoint.id, endpoint, events: METRICS_WEBHOOK_EVENTS, created: false, updated: true };
    }
    const created = await callResendApi({
        creds: input.creds,
        path: "/webhooks",
        body: {
            endpoint,
            events: METRICS_WEBHOOK_EVENTS,
        },
    });
    const webhookId = typeof created.data?.id === "string" ? created.data.id : undefined;
    const signingSecret = typeof created.data?.signing_secret === "string" ? created.data.signing_secret : undefined;
    if (!created.ok || !webhookId) {
        return {
            ok: false,
            status: created.status,
            error: created.error ?? "Failed to create Resend metrics webhook. Use a Resend API key with full access.",
        };
    }
    await updateResendWebhookMetadata({
        auth: input.auth,
        webhookId,
        endpoint,
        signingSecret,
    });
    return { ok: true, webhookId, endpoint, events: METRICS_WEBHOOK_EVENTS, created: true };
}
//# sourceMappingURL=resend-broadcast.js.map

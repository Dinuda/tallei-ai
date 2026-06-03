// @ts-nocheck
import { formatResendFromAddress, resendApiRequest, resolveResendCredentials, } from "./resend-email.js";
let resendRequestQueue = Promise.resolve();
let lastResendRequestAt = 0;
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
    };
}
export async function resolveResendMarketingCredentials(auth) {
    return resolveResendCredentials(auth);
}
//# sourceMappingURL=resend-broadcast.js.map

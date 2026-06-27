import { Router, type Request, type Response } from "express";

import { config } from "../../../../config/index.js";
import {
  handleComposioAuthWebhook,
  normalizeComposioWebhookPayload,
  verifyComposioWebhookSignatureDetailed,
} from "../../../../integrations/composio/webhooks.js";
import { dispatchComposioTriggerToLoops } from "../../../../integrations/composio/webhook-dispatch.js";
import {
  composioWebhookSecretsToTry,
  ensureComposioWebhookSecretsHydrated,
  syncComposioWebhookSecretsFromApi,
} from "../../../../integrations/composio/webhook-subscription.js";

async function handleComposioWebhook(req: Request, res: Response): Promise<void> {
  try {
    await ensureComposioWebhookSecretsHydrated();

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signatureHeaders = {
      webhookId: typeof req.headers["webhook-id"] === "string" ? req.headers["webhook-id"] : undefined,
      webhookTimestamp: typeof req.headers["webhook-timestamp"] === "string" ? req.headers["webhook-timestamp"] : undefined,
      webhookSignature: typeof req.headers["webhook-signature"] === "string" ? req.headers["webhook-signature"] : undefined,
      legacySignature: typeof req.headers["x-composio-signature"] === "string" ? req.headers["x-composio-signature"] : undefined,
    };

    let verification = verifyComposioWebhookSignatureDetailed(rawBody, signatureHeaders);
    if (!verification.ok && verification.reason === "invalid_signature") {
      await syncComposioWebhookSecretsFromApi({ force: true });
      verification = verifyComposioWebhookSignatureDetailed(rawBody, signatureHeaders);
    }

    if (!verification.ok) {
      console.warn("[webhook/composio] signature rejected", {
        reason: verification.reason,
        secretsTried: composioWebhookSecretsToTry().length,
        hasWebhookId: Boolean(signatureHeaders.webhookId),
        hasWebhookTimestamp: Boolean(signatureHeaders.webhookTimestamp),
        hasWebhookSignature: Boolean(signatureHeaders.webhookSignature),
        hasLegacySignature: Boolean(signatureHeaders.legacySignature),
        hasRawBody: Boolean(rawBody?.length),
      });
      res.status(401).json({ error: "Invalid webhook signature", reason: verification.reason });
      return;
    }

    const normalized = normalizeComposioWebhookPayload(req.body);
    if (normalized.kind === "auth_event") {
      res.json(handleComposioAuthWebhook(normalized.eventType));
      return;
    }
    if (normalized.kind === "ignored") {
      res.json({ ok: true, kind: "ignored", started: [] });
      return;
    }

    const result = await dispatchComposioTriggerToLoops({
      entityId: normalized.entityId,
      triggerSlug: normalized.triggerSlug,
      externalEventId: normalized.externalEventId,
      payload: normalized.payload,
    });
    if (result.reason === "concurrency_cap_reached") {
      console.warn("[webhook/composio] concurrency cap reached — Composio may retry", {
        triggerSlug: normalized.triggerSlug,
        entityId: normalized.entityId,
        skippedDueToCap: result.skippedDueToCap,
        runningEventRuns: result.runningEventRuns,
        cap: config.loopMaxConcurrentEventRuns,
      });
      res.status(503).json({ ok: false, kind: "trigger", retryable: true, ...result });
      return;
    }
    if (result.reason && result.started.length === 0) {
      console.warn("[webhook/composio] no runs started", {
        reason: result.reason,
        triggerSlug: normalized.triggerSlug,
        entityId: normalized.entityId,
        matchedLoops: result.matchedLoops,
      });
    }
    res.json({ ok: true, kind: "trigger", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    console.error("[webhook/composio] dispatch failed", { error: message });
    res.status(500).json({ error: message });
  }
}

const router = Router();

router.post("/composio", (req, res) => {
  void handleComposioWebhook(req, res);
});

export default router;
export { handleComposioWebhook };

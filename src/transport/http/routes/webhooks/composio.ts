import { Router, type Request, type Response } from "express";

import {
  handleComposioAuthWebhook,
  normalizeComposioWebhookPayload,
  verifyComposioWebhookSignature,
} from "../../../../integrations/composio/webhooks.js";
import { dispatchComposioTriggerToLoops } from "../../../../integrations/composio/webhook-dispatch.js";

async function handleComposioWebhook(req: Request, res: Response): Promise<void> {
  try {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const isValid = verifyComposioWebhookSignature(rawBody, {
      webhookId: typeof req.headers["webhook-id"] === "string" ? req.headers["webhook-id"] : undefined,
      webhookTimestamp: typeof req.headers["webhook-timestamp"] === "string" ? req.headers["webhook-timestamp"] : undefined,
      webhookSignature: typeof req.headers["webhook-signature"] === "string" ? req.headers["webhook-signature"] : undefined,
      legacySignature: typeof req.headers["x-composio-signature"] === "string" ? req.headers["x-composio-signature"] : undefined,
    });
    if (!isValid) {
      res.status(401).json({ error: "Invalid webhook signature" });
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
    res.json({ ok: true, kind: "trigger", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    res.status(500).json({ error: message });
  }
}

const router = Router();

router.post("/composio", (req, res) => {
  void handleComposioWebhook(req, res);
});

export default router;
export { handleComposioWebhook };

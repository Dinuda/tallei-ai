import { Router, type Response } from "express";
import { z } from "zod";

import {
  completeChannelSetup,
  disconnectChannel,
  listChannelsOverview,
  processResendInboundWebhook,
  processTelegramWebhook,
  sendChannelTest,
  setPrimaryChannel,
  startChannelSetup,
} from "../../../services/channels.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

const startSetupSchema = z.object({
  kind: z.enum(["telegram", "gmail", "email"]),
  mode: z.enum(["default", "botfather", "session"]).optional(),
  label: z.string().trim().max(120).optional().nullable(),
  bot_token: z.string().trim().min(1).optional(),
});

const completeSetupSchema = z.object({
  bot_token: z.string().trim().min(1).optional(),
});

const channelIdSchema = z.object({
  id: z.string().uuid(),
});

router.post("/webhooks/telegram", async (req, res: Response) => {
  try {
    const action = await processTelegramWebhook({
      body: req.body,
      secretToken: typeof req.headers["x-telegram-bot-api-secret-token"] === "string"
        ? req.headers["x-telegram-bot-api-secret-token"]
        : undefined,
    });
    res.json({ ok: true, action: action.type });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram webhook failed";
    res.status(400).json({ error: message });
  }
});

router.post("/webhooks/resend", async (req, res: Response) => {
  try {
    const action = await processResendInboundWebhook({ body: req.body });
    res.json({ ok: true, action: action.type });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend inbound webhook failed";
    res.status(400).json({ error: message });
  }
});

router.use(authMiddleware);

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const overview = await listChannelsOverview(req.authContext!);
    res.json(overview);
  } catch (error) {
    console.error("Error listing channels:", error);
    res.status(500).json({ error: "Failed to list channels" });
  }
});

router.post("/setup/start", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = startSetupSchema.parse(req.body ?? {});
    const session = await startChannelSetup({
      auth: req.authContext!,
      kind: body.kind,
      mode: body.mode,
      label: body.label ?? null,
      botToken: body.bot_token,
    });
    res.status(201).json({ session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to start channel setup";
    res.status(400).json({ error: message });
  }
});

router.post("/setup/:id/complete", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const params = channelIdSchema.parse({ id: req.params.id });
    const body = completeSetupSchema.parse(req.body ?? {});
    const session = await completeChannelSetup({
      auth: req.authContext!,
      sessionId: params.id,
      botToken: body.bot_token,
    });
    res.json({ session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to complete channel setup";
    res.status(400).json({ error: message });
  }
});

router.post("/:id/primary", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = channelIdSchema.parse({ id: req.params.id });
    const channel = await setPrimaryChannel(req.authContext!, id);
    res.json({ channel });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to set primary channel";
    res.status(400).json({ error: message });
  }
});

router.post("/:id/test", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = channelIdSchema.parse({ id: req.params.id });
    const result = await sendChannelTest(req.authContext!, id);
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Failed to send test message" });
      return;
    }
    res.json({ ok: true, provider: result.provider });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to send test message";
    res.status(400).json({ error: message });
  }
});

router.delete("/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = channelIdSchema.parse({ id: req.params.id });
    await disconnectChannel(req.authContext!, id);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to disconnect channel";
    res.status(400).json({ error: message });
  }
});

export default router;

import { Router, type Response } from "express";
import { z } from "zod";

import {
  continueConnectorAuth,
  getConnectorAuthSession,
  handleComposioWebhook,
  getResendConnectorSetup,
  listComposioToolkitTools,
  listComposioToolkits,
  listConnectorAccounts,
  removeResendConnector,
  removeConnectorAccount,
  startConnectorAuth,
  upsertResendConnector,
  verifyComposioWebhookSignature,
} from "../../../services/connectors/composio.js";
import { pool } from "../../../infrastructure/db/index.js";
import { handleComposioTriggerWebhook } from "../../../services/loop-runtime/composio-trigger.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/composio/webhook", async (req, res: Response) => {
  try {
    const signature = typeof req.headers["x-composio-signature"] === "string"
      ? req.headers["x-composio-signature"]
      : undefined;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const isValid = verifyComposioWebhookSignature(rawBody, signature);
    if (!isValid) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    const authResult = await handleComposioWebhook(req.body);
    const result = authResult.processed ? authResult : await handleComposioTriggerWebhook(req.body);
    res.json(result);
  } catch (error) {
    console.error("Error handling composio webhook:", error);
    res.status(500).json({ error: "Failed to handle composio webhook" });
  }
});

router.use(authMiddleware);

const createAuthSessionSchema = z.object({
  app_key: z.string().min(1).optional(),
  required_scopes: z.array(z.string()).optional().default([]),
  redirect_uri: z.string().url().optional(),
  workflow_builder_session_id: z.string().uuid().optional(),
  build_requirement_id: z.string().min(1).optional(),
});

const continueAuthSchema = z.object({
  external_account_id: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});
const saveResendSchema = z.object({
  api_key: z.string().min(1),
  label: z.string().max(80).optional(),
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const connectors = await listConnectorAccounts(req.authContext!);
    res.json({
      connectors: connectors.map(({ externalAccountId: _externalAccountId, ...connector }) => connector),
    });
  } catch (error) {
    console.error("Error listing connectors:", error);
    res.status(500).json({ error: "Failed to list connectors" });
  }
});

router.get("/composio/toolkits", requireScopes(["memory:read"]), async (_req: AuthRequest, res: Response) => {
  try {
    const toolkits = await listComposioToolkits();
    res.json({ toolkits });
  } catch (error) {
    console.error("Error listing Composio toolkits:", error);
    res.json({ toolkits: [] });
  }
});

router.get("/composio/toolkits/:toolkit/tools", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const tools = await listComposioToolkitTools(String(req.params.toolkit || ""));
    res.json({ tools });
  } catch (error) {
    console.error("Error listing Composio toolkit tools:", error);
    res.status(500).json({ error: "Failed to list Composio toolkit tools" });
  }
});

router.get("/resend", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const setup = await getResendConnectorSetup(req.authContext!);
    res.json(setup);
  } catch (error) {
    console.error("Error loading Resend connector setup:", error);
    res.status(500).json({ error: "Failed to load Resend connector setup" });
  }
});

router.post("/resend", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveResendSchema.parse(req.body ?? {});
    const setup = await upsertResendConnector({
      auth: req.authContext!,
      apiKey: body.api_key,
      label: body.label,
    });
    res.status(201).json(setup);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /(Invalid Resend API key format|Resend key verification failed)/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error saving Resend connector:", error);
    res.status(500).json({ error: "Failed to save Resend connector" });
  }
});

router.delete("/resend", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    await removeResendConnector(req.authContext!, undefined);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error removing Resend connector:", error);
    res.status(500).json({ error: "Failed to remove Resend connector" });
  }
});

router.delete("/resend/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    await removeResendConnector(req.authContext!, String(req.params.id));
    res.json({ success: true });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error removing Resend connector:", error);
    res.status(500).json({ error: "Failed to remove Resend connector" });
  }
});

router.post("/:provider/auth-sessions", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const provider = String(req.params.provider || "").trim();
    const body = createAuthSessionSchema.parse(req.body ?? {});
    if (body.workflow_builder_session_id) {
      const builder = await pool.query(
        `SELECT 1 FROM workflow_builder_sessions
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
        [body.workflow_builder_session_id, req.authContext!.tenantId, req.authContext!.userId],
      );
      if (!builder.rows[0]) {
        res.status(404).json({ error: "Workflow builder session not found" });
        return;
      }
    }

    const session = await startConnectorAuth({
      auth: req.authContext!,
      provider,
      appKey: body.app_key ?? null,
      requiredScopes: body.required_scopes,
      redirectUri: body.redirect_uri ?? null,
      workflowBuilderSessionId: body.workflow_builder_session_id ?? null,
      buildRequirementId: body.build_requirement_id ?? null,
    });

    res.status(201).json({
      auth_session_id: session.sessionId,
      setup_url: session.setupUrl,
      expires_at: session.expiresAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /Composio is required/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /(Failed to start Resend auth|Failed to create Composio connect link|auth config|toolkit)/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error creating connector auth session:", error);
    res.status(500).json({ error: "Failed to create connector auth session" });
  }
});

router.get("/auth-sessions/:id", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await getConnectorAuthSession({
      auth: req.authContext!,
      authSessionId: String(req.params.id),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error reading connector auth session:", error);
    res.status(500).json({ error: "Failed to read connector auth session" });
  }
});

router.post("/auth-sessions/:id/continue", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = continueAuthSchema.parse(req.body ?? {});
    const result = await continueConnectorAuth({
      auth: req.authContext!,
      authSessionId: String(req.params.id),
      externalAccountId: body.external_account_id,
      scopes: body.scopes,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error continuing connector auth:", error);
    res.status(500).json({ error: "Failed to continue connector auth" });
  }
});

router.delete("/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    await removeConnectorAccount(req.authContext!, String(req.params.id));
    res.json({ success: true });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error removing connector account:", error);
    res.status(500).json({ error: "Failed to remove connector account" });
  }
});

export default router;

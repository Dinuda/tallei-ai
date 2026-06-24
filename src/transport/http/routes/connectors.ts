import { Router, type Response } from "express";
import { z } from "zod";

import {
  disconnectToolkit,
  getToolkitConnectionStatus,
  listWorkspaceConnectors,
  startToolkitAuthorization,
  verifyToolkitConnection,
} from "../../../integrations/composio/accounts.js";
import { listToolkits } from "../../../integrations/composio/tools.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /not connected|not configured|invalid/i.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

router.use(authMiddleware);
router.use(workspaceMiddleware);

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const connectors = await listWorkspaceConnectors(req.authContext!);
    res.json({ connectors });
  } catch (error) {
    sendError(res, error, "Failed to list connectors");
  }
});

router.get("/composio/toolkits", requireScopes(["memory:read"]), async (_req: AuthRequest, res: Response) => {
  try {
    const toolkits = await listToolkits();
    res.json({ toolkits });
  } catch (error) {
    sendError(res, error, "Failed to list Composio toolkits");
  }
});

router.get("/status/:toolkit", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const status = await getToolkitConnectionStatus(req.authContext!, String(req.params.toolkit));
    res.json(status);
  } catch (error) {
    sendError(res, error, "Failed to read connector status");
  }
});

router.post("/:toolkit/authorize", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ callbackUrl: z.string().url().optional() }).parse(req.body ?? {});
    const result = await startToolkitAuthorization(req.authContext!, String(req.params.toolkit), {
      callbackUrl: body.callbackUrl,
    });
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error, "Failed to start connector authorization");
  }
});

router.post(
  "/authorize/:connectionRequestId/verify",
  requireScopes(["memory:write"]),
  async (req: AuthRequest, res: Response) => {
    try {
      const body = z.object({
        toolkit: z.string().optional(),
        timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
      }).parse(req.body ?? {});
      const status = await verifyToolkitConnection(req.authContext!, {
        connectionRequestId: String(req.params.connectionRequestId),
        toolkit: body.toolkit,
        timeoutMs: body.timeoutMs,
      });
      res.json(status);
    } catch (error) {
      sendError(res, error, "Failed to verify connector");
    }
  },
);

router.delete("/:toolkit", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await disconnectToolkit(req.authContext!, String(req.params.toolkit));
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to disconnect connector");
  }
});

export default router;

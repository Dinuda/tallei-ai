import { Router, type Response } from "express";
import { z } from "zod";

import {
  disconnectToolkit,
  getToolkitConnectionStatus,
  listAllToolkitsWithStatus,
  getToolkitCatalogEntry,
  listWorkspaceConnectors,
  startToolkitAuthorization,
  verifyToolkitConnection,
} from "../../../integrations/composio/accounts.js";
import { listToolkits, getAllTools } from "../../../integrations/composio/tools.js";
import { listComposioTriggerTypes } from "../../../integrations/composio/triggers.js";
import { resolveToolkitSlug } from "../../../integrations/composio/auth.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();

export type ConnectorApiErrorCode =
  | "COMPOSIO_NOT_CONFIGURED"
  | "AUTH_CONFIG_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONNECTOR_ERROR";

function resolveConnectorErrorCode(message: string): ConnectorApiErrorCode {
  if (/composio is not configured/i.test(message)) return "COMPOSIO_NOT_CONFIGURED";
  if (/auth config|configured composio/i.test(message)) return "AUTH_CONFIG_UNAVAILABLE";
  if (/not found/i.test(message)) return "NOT_FOUND";
  return "CONNECTOR_ERROR";
}

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ code: "VALIDATION_FAILED" as const, error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const code = resolveConnectorErrorCode(message);
  const status = code === "NOT_FOUND"
    ? 404
    : code === "COMPOSIO_NOT_CONFIGURED" || code === "AUTH_CONFIG_UNAVAILABLE" || /not connected|invalid/i.test(message)
      ? 400
      : 500;
  res.status(status).json({ code, error: message });
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

router.get("/catalog", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = z.object({
      toolkit: z.string().min(1).optional(),
      includeTriggers: z.enum(["true", "false"]).optional(),
    }).parse(req.query);

    if (query.toolkit?.trim()) {
      const entry = await getToolkitCatalogEntry(req.authContext!, query.toolkit, {
        includeTriggers: query.includeTriggers === "true",
      });
      res.json({ scoped: true, toolkit: entry.toolkit, ...(entry.triggers ? { triggers: entry.triggers } : {}) });
      return;
    }

    const { toolkits, total } = await listAllToolkitsWithStatus(req.authContext!);
    res.json({ scoped: false, toolkits, total });
  } catch (error) {
    sendError(res, error, "Failed to list connector catalog");
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

router.get("/:toolkit/triggers", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const toolkit = await resolveToolkitSlug(String(req.params.toolkit));
    const triggers = await listComposioTriggerTypes(toolkit);
    res.json({ toolkit, triggers });
  } catch (error) {
    sendError(res, error, "Failed to list connector triggers");
  }
});

router.get("/:toolkit/actions", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const toolkit = await resolveToolkitSlug(String(req.params.toolkit));
    const actions = await getAllTools(toolkit);
    res.json({
      toolkit,
      actions: actions.map((action) => ({
        slug: action.actionSlug,
        name: action.name,
        description: action.description,
        inputSchema: action.inputSchema ?? {},
      })),
    });
  } catch (error) {
    sendError(res, error, "Failed to list connector actions");
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

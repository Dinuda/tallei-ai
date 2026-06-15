import type { Response, NextFunction } from "express";

import { resolveWorkspaceId } from "../../../services/workspace/index.js";
import type { AuthRequest } from "./auth.middleware.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function workspaceMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.authContext) {
    next();
    return;
  }

  const header = req.headers["x-workspace-id"];
  const requested = typeof header === "string" && UUID_RE.test(header) ? header : undefined;

  try {
    const workspaceId = await resolveWorkspaceId(req.authContext, requested);
    req.authContext = { ...req.authContext, workspaceId };
    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid workspace";
    res.status(requested ? 404 : 500).json({ error: message });
  }
}

export { requireWorkspaceId } from "../../../services/workspace/context.js";

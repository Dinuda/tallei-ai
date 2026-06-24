import { Router, type Response } from "express";
import { z } from "zod";

import { config } from "../../../config/index.js";
import {
  getApprovalRequest,
  listPendingApprovals,
  resolveApprovalRequest,
} from "../../../loops/store.js";
import { resolveLoopAuthWorkspace } from "../../../loops/service.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

function sendError(res: Response, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  res.status(/not found/i.test(message) ? 404 : 500).json({ error: message });
}

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const auth = await resolveLoopAuthWorkspace(req.authContext!);
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    if (status !== "pending") {
      res.json({ approvals: [] });
      return;
    }
    const approvals = await listPendingApprovals(auth, auth.workspaceId!);
    res.json({ approvals });
  } catch (error) {
    sendError(res, error, "Failed to list approvals");
  }
});

router.post("/:approvalId/decide", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      decision: z.enum(["approve", "reject", "edit"]),
      editedArgs: z.record(z.unknown()).optional(),
      comment: z.string().optional(),
    }).parse(req.body ?? {});

    const approval = await getApprovalRequest(approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    const status = body.decision === "approve" || body.decision === "edit" ? "approved" : "rejected";
    const updated = await resolveApprovalRequest(approvalId, status, {
      decision: body.decision,
      editedArgs: body.editedArgs,
      comment: body.comment,
    });

    if (config.temporalEnabled && approval.temporal_workflow_id) {
      const { signalApprovalDecision } = await import("../../../temporal/client.js");
      await signalApprovalDecision(approval.temporal_workflow_id, {
        approvalId,
        decision: body.decision,
        editedArgs: body.editedArgs,
        comment: body.comment,
      });
    }

    res.json({ approval: updated });
  } catch (error) {
    sendError(res, error, "Failed to decide approval");
  }
});

export default router;

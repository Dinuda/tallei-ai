import { Router, type Response } from "express";

import {
  approveWorkflowRunById,
  approveWorkflowSuggestion,
  consumeWorkflowApprovalToken,
  dismissWorkflowSuggestion,
  resolveWorkflowApprovalToken,
  skipWorkflowRunById,
} from "../../../services/workflow-automation.js";

const router = Router();

router.get("/:token", async (req, res: Response) => {
  try {
    const token = String(req.params.token);
    const details = await resolveWorkflowApprovalToken(token);
    if (!details) {
      res.status(404).json({ error: "Approval token not found" });
      return;
    }
    res.json(details);
  } catch (error) {
    console.error("Error loading approval token:", error);
    res.status(500).json({ error: "Failed to load approval token" });
  }
});

router.post("/:token/approve", async (req, res: Response) => {
  try {
    const token = String(req.params.token);
    const details = await resolveWorkflowApprovalToken(token);
    if (!details) {
      res.status(404).json({ error: "Approval token not found" });
      return;
    }
    if (details.expired) {
      res.status(410).json({ error: "Approval token expired" });
      return;
    }
    if (details.consumedAt) {
      res.status(409).json({ error: "Approval token already consumed" });
      return;
    }

    if (details.targetType !== "workflow_suggestion" && details.targetType !== "workflow_run") {
      res.status(400).json({ error: "Unsupported target type" });
      return;
    }

    const auth = {
      tenantId: details.tenantId,
      userId: details.userId,
      authMode: "internal" as const,
      plan: "pro" as const,
    };
    const result = details.targetType === "workflow_run"
      ? await approveWorkflowRunById({ auth, runId: details.targetId, channel: details.channel === "whatsapp" ? "whatsapp" : "email" })
      : await approveWorkflowSuggestion({ auth, suggestionId: details.targetId });

    await consumeWorkflowApprovalToken(token);
    res.json({ approved: true, ...result });
  } catch (error) {
    if (error instanceof Error && /not found|not pending/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /waiting for approval|Missing connected Composio|Composio/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error approving workflow via token:", error);
    res.status(500).json({ error: "Failed to approve workflow" });
  }
});

router.post("/:token/ignore", async (req, res: Response) => {
  try {
    const token = String(req.params.token);
    const details = await resolveWorkflowApprovalToken(token);
    if (!details) {
      res.status(404).json({ error: "Approval token not found" });
      return;
    }
    if (details.targetType !== "workflow_suggestion" && details.targetType !== "workflow_run") {
      res.status(400).json({ error: "Unsupported target type" });
      return;
    }

    const auth = {
      tenantId: details.tenantId,
      userId: details.userId,
      authMode: "internal" as const,
      plan: "pro" as const,
    };
    if (details.targetType === "workflow_run") {
      await skipWorkflowRunById({ auth, runId: details.targetId, channel: details.channel === "whatsapp" ? "whatsapp" : "email" });
    } else {
      await dismissWorkflowSuggestion({
        auth,
        suggestionId: details.targetId,
        reason: "ignored_from_channel",
      });
    }
    await consumeWorkflowApprovalToken(token);

    res.json({ ignored: true });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error ignoring workflow via token:", error);
    res.status(500).json({ error: "Failed to ignore workflow" });
  }
});

export default router;

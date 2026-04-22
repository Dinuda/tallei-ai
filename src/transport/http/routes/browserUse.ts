import { Router } from "express";
import { z } from "zod";
import { config } from "../../../config/index.js";
import {
  claudeBrowserWorkerService,
  type BrowserWorkerExecuteRequest,
} from "../../../infrastructure/browser/claude-browser-worker.js";

const executeSchema = z.object({
  mode: z.enum(["student"]),
  sessionId: z.string().uuid(),
  state: z.enum([
    "browser_started",
    "claude_authenticated",
    "connector_connected",
    "project_upserted",
    "instructions_applied",
    "verified",
  ]),
  projectName: z.string().trim().min(1).max(120),
  authCompleted: z.boolean().optional(),
  applyProjectInstructions: z.boolean().optional(),
  projectInstructions: z.string().trim().min(1).max(20000).optional(),
  expectedInstructionsHash: z.string().trim().length(64).optional(),
  expectedInstructionSnippet: z.string().trim().min(1).max(240).optional(),
  hyperAgentActionCacheByState: z.record(z.string(), z.unknown()).optional(),
  attempt: z.number().int().min(1).max(10),
  instruction: z.object({
    state: z.enum([
      "browser_started",
      "claude_authenticated",
      "connector_connected",
      "project_upserted",
      "instructions_applied",
      "verified",
    ]),
    objective: z.string().min(1),
    selectors: z.array(z.string()).max(30),
    expectedSignal: z.string().min(1),
  }),
});

const webhookTestSchema = z.object({
  type: z.literal("test"),
  timestamp: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const router = Router();

function isWorkerAuthorized(header: string | undefined): boolean {
  if (!config.browserWorkerApiKey) {
    return config.nodeEnv !== "production";
  }
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === config.browserWorkerApiKey;
}

router.post("/claude-onboarding/execute", async (req, res) => {
  try {
    const webhookTest = webhookTestSchema.safeParse(req.body ?? {});
    if (webhookTest.success) {
      res.json({ ok: true, received: webhookTest.data.type, timestamp: webhookTest.data.timestamp });
      return;
    }

    if (!isWorkerAuthorized(req.headers.authorization)) {
      res.status(401).json({ error: "Unauthorized worker call" });
      return;
    }

    const parsed = executeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid worker payload", details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data as BrowserWorkerExecuteRequest;
    const result = await claudeBrowserWorkerService.execute(payload);
    if (result.status === "error") {
      res.status(422).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    console.error("Browser worker execution failed:", error);
    res.status(500).json({ status: "error", error: "Browser worker internal error" });
  }
});

export default router;

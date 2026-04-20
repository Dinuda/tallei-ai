import { Router, Response } from "express";
import { z } from "zod";

import {
  listDocuments,
  recallDocument,
  deleteDocumentByRef,
} from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

const refParamSchema = z.object({
  ref: z.string().min(1, "ref is required"),
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await listDocuments(req.authContext!);
    res.json(result);
  } catch (error) {
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    console.error("Error listing documents:", error);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

router.get("/:ref", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = refParamSchema.parse({ ref: decodeURIComponent(String(req.params.ref ?? "")) });
    const result = await recallDocument(parsed.ref, req.authContext!);
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error loading document:", error);
    res.status(500).json({ error: "Failed to load document" });
  }
});

router.delete("/:ref", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = refParamSchema.parse({ ref: decodeURIComponent(String(req.params.ref ?? "")) });
    const result = await deleteDocumentByRef(parsed.ref, req.authContext!);
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error deleting document:", error);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

export default router;

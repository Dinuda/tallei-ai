import { Router, Response } from "express";
import multer from "multer";
import { z } from "zod";

import { assertUploadThingConfigured, UploadThingConfigError } from "../../../infrastructure/storage/uploadthing-client.js";
import {
  listDocuments,
  recallDocument,
  deleteDocumentByRef,
  stashDocument,
  stashDocumentNote,
  DocumentSizeExceededError,
} from "../../../services/documents.js";
import { extractPdfText, ingestUploadedFilesToDocuments } from "../../../services/uploaded-file-ingest.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { uploadBlobBodySchema } from "../schemas/uploaded-files.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

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

router.post("/upload-blob", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = uploadBlobBodySchema.parse(req.body ?? {});
    assertUploadThingConfigured();

    const { saved, errors } = await ingestUploadedFilesToDocuments(body.openaiFileIdRefs, req.authContext!, {
      title: body.title,
      conversation_id: body.conversation_id ?? null,
    });

    res.json({
      success: true,
      count: saved.length,
      saved,
      errors,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof DocumentSizeExceededError) {
      res.status(413).json({ error: error.message });
      return;
    }
    console.error("Error uploading document blob:", error);
    res.status(500).json({ error: "Failed to upload document blob" });
  }
});

// Direct file upload — used by browser extension or dashboard drag-and-drop.
// Accepts multipart/form-data with a `file` field (text, markdown, or PDF).
// Optional `mode` field: "note" (default, fast) or "blob" (full archive).
router.post(
  "/upload",
  requireScopes(["memory:write"]),
  upload.single("file"),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded. Send a multipart/form-data request with a `file` field." });
        return;
      }

      const mode = (req.body?.mode === "blob" ? "blob" : "note") as "note" | "blob";
      const title = typeof req.body?.title === "string" && req.body.title ? req.body.title : req.file.originalname;
      const mime = req.file.mimetype;

      let text: string;
      if (mime === "application/pdf") {
        text = await extractPdfText(req.file.buffer);
        if (!text.trim()) {
          res.status(422).json({ error: "PDF appears to be image-only or unreadable. Use a text-based PDF." });
          return;
        }
      } else {
        text = req.file.buffer.toString("utf8");
      }

      if (mode === "blob") {
        const result = await stashDocument(text, req.authContext!, { title, filename: req.file.originalname });
        res.json({ ref: result.refHandle, status: result.status, mode: "blob", title });
      } else {
        // Generate a lightweight note from the first 3000 chars so we don't hit OpenAI for large files here.
        const preview = text.slice(0, 3000);
        const lines = preview.split("\n").map((l) => l.trim()).filter((l) => l.length > 20).slice(0, 8);
        const result = await stashDocumentNote(
          { title, key_points: lines, summary: `Uploaded file: ${req.file.originalname}`, source_hint: `Uploaded via Tallei — ${req.file.originalname}` },
          req.authContext!
        );
        res.json({ ref: result.refHandle, status: result.status, mode: "note", title });
      }
    } catch (err) {
      if (err instanceof PlanRequiredError) {
        res.status(402).json({ error: err.message });
        return;
      }
      if (err instanceof DocumentSizeExceededError) {
        res.status(413).json({ error: err.message });
        return;
      }
      console.error("Error uploading document:", err);
      res.status(500).json({ error: "Failed to upload document" });
    }
  }
);

export default router;

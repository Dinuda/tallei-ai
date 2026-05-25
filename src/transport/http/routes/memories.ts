import { Router, Response } from "express";
import multer from "multer";
import { basename } from "node:path";
import { z } from "zod";
import { config } from "../../../config/index.js";
import type { BulkIngestDocument } from "../../../orchestration/memory/chatgpt-bulk-ingest.js";
import type { ChatGptImportRequest } from "../../../orchestration/memory/chatgpt-import.usecase.js";
import {
  saveMemory,
  savePreference,
  recallMemories,
  listMemoriesPage,
  listPreferences,
  forgetPreference,
  deleteMemory,
} from "../../../services/memory.js";
import {
  enqueueChatGptImportJob,
  getChatGptImportJobStatus,
  persistChatGptImportJob,
} from "../../../services/chatgpt-import-jobs.js";
import {
  buildStorageRef,
  ensureUserImportDir,
  resolveStoragePath,
  sanitizeImportFilename,
} from "../../../services/chatgpt-import-storage.js";
import {
  getMemoryCleanupRun,
  listMemoryCleanupRuns,
  resetMemoryCleanupReviewFlags,
  runMemoryCleanupForUser,
  sendMemoryCleanupAdminEmail,
} from "../../../services/memory-cleanup.js";
import {
  getLoopMinerRunEmbeddingMapForUser,
  getLoopMinerRunStatusForUser,
  listLoopMinerRunsForUser,
  queueLoopMinerRunForUser,
} from "../../../orchestration/loop-miner/loop-miner.js";
import { createLogger } from "../../../observability/index.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
const logger = createLogger({ baseFields: { component: "memories_http_routes" } });
const LOOP_MINER_STALE_RUNNING_MAX_AGE_MS = 60 * 60 * 1000;

interface ChatGptImportUploadMeta {
  storageRef: string;
  originalFilename: string;
  absolutePath: string;
}

interface ChatGptImportAuthRequest extends AuthRequest {
  chatGptImportUploads?: ChatGptImportUploadMeta[];
}

router.use(authMiddleware);

const saveSchema = z.object({
  content: z.string().min(1, "content is required"),
  platform: z.enum(["claude", "chatgpt", "gemini", "other"]).default("other"),
  memory_type: z.enum(["preference", "fact", "event", "decision", "note"]).optional(),
  category: z.string().optional(),
  is_pinned: z.boolean().optional(),
  preference_key: z.string().optional(),
});

const recallSchema = z.object({
  q: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  types: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
      return undefined;
    },
    z.array(z.enum(["preference", "fact", "event", "decision", "note"])).optional()
  ),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const cleanupRunSchema = z.object({
  dryRun: z.boolean().optional(),
  maxMemories: z.number().int().min(1).max(5000).optional(),
  processAll: z.boolean().optional(),
  includeReviewed: z.boolean().optional(),
  logImplicitKeeps: z.boolean().optional(),
  emailAdmin: z.boolean().optional(),
  selectionStrategy: z.enum(["newest_hybrid", "current_priority"]).optional(),
  newestLimit: z.number().int().min(1).max(5000).optional(),
  interestingLimit: z.number().int().min(0).max(5000).optional(),
});

const loopMinerRunSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90).optional(),
  processAll: z.boolean().optional(),
  memoryNewestLimit: z.number().int().min(1).max(5000).optional(),
  memoryInterestingLimit: z.number().int().min(0).max(5000).optional(),
});

const bulkJsonRoleSchema = z.enum([
  "conversations",
  "shared_conversations",
  "profile",
  "other_json",
  "dat_text",
  "dat_metadata",
  "library_catalog",
]);

const chatGptImportSchema = z.object({
  input: z.string().optional(),
  apply: z.boolean().optional(),
  modeHint: z.enum(["json_export", "paste", "bulk_export"]).optional(),
  bulkDocuments: z.array(z.object({
    path: z.string(),
    role: bulkJsonRoleSchema,
    data: z.unknown(),
  })).optional(),
  ingestSummary: z.object({
    sourcesParsed: z.array(z.string()),
    skipped: z.object({
      binaryDat: z.number(),
      binaryDatSamples: z.array(z.string()),
      libraryCatalog: z.number(),
      other: z.number(),
      otherSamples: z.array(z.string()),
    }),
    dat: z.object({
      inspected: z.number(),
      extracted: z.number(),
      extractedSamples: z.array(z.string()),
      metadataOnly: z.number(),
      metadataSamples: z.array(z.string()),
      skipped: z.number(),
    }).optional(),
    hasConversationsJson: z.boolean(),
  }).optional(),
  ingestWarnings: z.array(z.string()).optional(),
});

const uploadChatGptImport = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const auth = (req as ChatGptImportAuthRequest).authContext;
      if (!auth?.userId) {
        cb(new Error("Unauthorized"), "");
        return;
      }
      ensureUserImportDir(auth.userId)
        .then((dir) => cb(null, dir))
        .catch((error) => cb(error as Error, ""));
    },
    filename(req, file, cb) {
      const authReq = req as ChatGptImportAuthRequest;
      const auth = authReq.authContext;
      if (!auth?.userId) {
        cb(new Error("Unauthorized"), "");
        return;
      }
      const storageRef = buildStorageRef(auth.userId, file.originalname);
      const absolutePath = resolveStoragePath(storageRef);
      authReq.chatGptImportUploads ??= [];
      authReq.chatGptImportUploads.push({
        storageRef,
        originalFilename: sanitizeImportFilename(file.originalname),
        absolutePath,
      });
      cb(null, basename(absolutePath));
    },
  }),
  limits: {
    fileSize: config.importMaxUploadBytes,
    files: 50,
  },
});

const chatGptImportFormSchema = z.object({
  input: z.string().optional(),
  apply: z.union([z.boolean(), z.string()]).optional(),
});

class ChatGptImportUploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function parseApplyFromMultipart(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function findFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseApplyLoose(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

const CONVERSATION_JSON_FILENAME = /^conversations(?:-\d+)?\.json$/i;
const OPTIONAL_PROFILE_JSON_FILENAME = /^(shared_conversations|user|user_settings)\.json$/i;

function isConversationJsonImportFilename(filename: string): boolean {
  const base = basename(filename.trim());
  return CONVERSATION_JSON_FILENAME.test(base) || OPTIONAL_PROFILE_JSON_FILENAME.test(base);
}

function isAllowedChatGptImportFilename(filename: string): boolean {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith(".zip")) return false;
  return isConversationJsonImportFilename(filename)
    || normalized.endsWith(".json")
    || normalized.endsWith(".jsonl")
    || normalized.endsWith(".txt");
}

function isMultipartRequest(req: AuthRequest): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.includes("multipart/form-data");
}

function maybeHandleMultipartChatGptImport(req: AuthRequest, res: Response, next: (error?: unknown) => void): void {
  if (!isMultipartRequest(req)) {
    next();
    return;
  }
  uploadChatGptImport.array("files", 50)(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        const maxGb = (config.importMaxUploadBytes / (1024 * 1024 * 1024)).toFixed(1);
        res.status(413).json({ error: `Each import file must be ${maxGb}GB or smaller.` });
        return;
      }
      res.status(400).json({ error: `Upload failed: ${error.message}` });
      return;
    }
    next(error);
  });
}

async function parseChatGptImportRequest(req: AuthRequest): Promise<ChatGptImportRequest> {
  if (isMultipartRequest(req)) {
    const authReq = req as ChatGptImportAuthRequest;
    const body = chatGptImportFormSchema.parse(req.body ?? {});
    const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
    const pastedInput = typeof body.input === "string" ? body.input.trim() : "";
    const apply = parseApplyFromMultipart(body.apply);

    const zipFiles = files.filter((file) => file.originalname.trim().toLowerCase().endsWith(".zip"));
    if (zipFiles.length > 0) {
      throw new ChatGptImportUploadError(
        422,
        "Extract the export locally and upload conversation JSON files (conversations.json or conversations-NNN.json)."
      );
    }

    const ingestableFiles = files.filter((file) => isAllowedChatGptImportFilename(file.originalname));
    const unsupported = files.filter((file) => !isAllowedChatGptImportFilename(file.originalname));

    if (unsupported.length > 0) {
      const names = unsupported.map((file) => file.originalname).join(", ");
      throw new ChatGptImportUploadError(
        422,
        `Unsupported file(s): ${names}. Upload conversations*.json (and optionally user.json) — not .dat media or ZIP archives.`
      );
    }

    if (ingestableFiles.length > 0) {
      const uploads = authReq.chatGptImportUploads ?? [];
      const jsonUploads = uploads.filter((entry) => isConversationJsonImportFilename(entry.originalFilename));
      if (jsonUploads.length === 0) {
        throw new ChatGptImportUploadError(
          422,
          "Upload conversation JSON files (conversations.json or conversations-NNN.json)."
        );
      }
      if (jsonUploads.length > 50) {
        throw new ChatGptImportUploadError(422, "Upload at most 50 conversation JSON files at once.");
      }
      return {
        mode: "conversation_json_files",
        storageRefs: jsonUploads.map((entry) => entry.storageRef),
        originalFilenames: jsonUploads.map((entry) => entry.originalFilename),
        importProfile: "inclusive",
        input: pastedInput,
        apply: false,
      };
    }

    if (!pastedInput) {
      throw new ChatGptImportUploadError(
        400,
        files.length === 0
          ? "Upload conversation JSON files from your extracted ChatGPT export."
          : "No importable JSON files received."
      );
    }
    return {
      input: pastedInput,
      apply,
    };
  }

  const root = (() => {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body) as unknown;
      } catch {
        return { input: req.body };
      }
    }
    return req.body ?? {};
  })();

  const rootRecord = asRecord(root) ?? {};
  const wrappers = [
    rootRecord,
    asRecord(rootRecord["data"]),
    asRecord(rootRecord["payload"]),
    asRecord(rootRecord["args"]),
    asRecord(rootRecord["input"]),
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  let normalizedInput: string | null = null;
  let normalizedApply: boolean | undefined;
  let normalizedModeHint: "json_export" | "paste" | "bulk_export" | undefined;
  for (const candidate of wrappers) {
    if (!normalizedInput) {
      normalizedInput = findFirstString(candidate, ["input", "text", "content", "memory_dump", "memoryDump"]);
    }
    if (normalizedApply === undefined && candidate["apply"] !== undefined) {
      normalizedApply = parseApplyLoose(candidate["apply"]);
    }
    if (!normalizedModeHint && typeof candidate["modeHint"] === "string") {
      const hint = candidate["modeHint"];
      if (hint === "json_export" || hint === "paste" || hint === "bulk_export" || hint === "dat_export") {
        normalizedModeHint = hint === "dat_export" ? "bulk_export" : hint;
      }
    }
  }

  const body = chatGptImportSchema.parse({
    input: normalizedInput ?? rootRecord["input"],
    apply: normalizedApply ?? rootRecord["apply"],
    modeHint: normalizedModeHint ?? rootRecord["modeHint"],
    bulkDocuments: rootRecord["bulkDocuments"],
    ingestSummary: rootRecord["ingestSummary"],
    ingestWarnings: rootRecord["ingestWarnings"],
  });
  const input = typeof body.input === "string" ? body.input : "";
  const hasBulkDocuments = Array.isArray(body.bulkDocuments) && body.bulkDocuments.length > 0;
  if (!input.trim() && !hasBulkDocuments && body.modeHint !== "bulk_export") {
    throw new ChatGptImportUploadError(400, "input is required");
  }
  if (!input.trim() && !hasBulkDocuments && body.modeHint === "bulk_export") {
    throw new ChatGptImportUploadError(
      400,
      "No importable JSON found. Upload your ChatGPT data export ZIP or conversations.json."
    );
  }
  const normalizedIngestSummary = body.ingestSummary
    ? {
      ...body.ingestSummary,
      dat: body.ingestSummary.dat ?? {
        inspected: 0,
        extracted: 0,
        extractedSamples: [],
        metadataOnly: 0,
        metadataSamples: [],
        skipped: 0,
      },
    }
    : undefined;
  return {
    input,
    apply: body.apply ?? false,
    ...(body.modeHint ? { modeHint: body.modeHint } : {}),
    ...(body.bulkDocuments
      ? { bulkDocuments: body.bulkDocuments as BulkIngestDocument[] }
      : {}),
    ...(normalizedIngestSummary ? { ingestSummary: normalizedIngestSummary } : {}),
    ...(body.ingestWarnings ? { ingestWarnings: body.ingestWarnings } : {}),
  };
}

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const result = await saveMemory(body.content, req.authContext!, body.platform, req.ip, {
      memoryType: body.memory_type,
      category: body.category ?? null,
      isPinned: body.is_pinned,
      preferenceKey: body.preference_key ?? null,
    });
    res.status(201).json({ success: true, memoryId: result.memoryId, title: result.title, summary: result.summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

router.post("/preferences", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const result = await savePreference(body.content, req.authContext!, body.platform, req.ip, {
      category: body.category ?? null,
      preferenceKey: body.preference_key ?? null,
    });
    res.status(201).json({ success: true, memoryId: result.memoryId, title: result.title, summary: result.summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving preference:", error);
    res.status(500).json({ error: "Failed to save preference" });
  }
});

router.post("/import/chatgpt", requireScopes(["memory:write"]), maybeHandleMultipartChatGptImport, async (req: AuthRequest, res: Response) => {
  try {
    const payload = await parseChatGptImportRequest(req);
    const queued = await enqueueChatGptImportJob(req.authContext!, payload);
    res.status(202).json(queued);
  } catch (error) {
    if (error instanceof ChatGptImportUploadError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error importing ChatGPT memories:", error);
    const detail = error instanceof Error ? error.message : undefined;
    res.status(500).json({
      error: "Failed to import ChatGPT memories",
      ...(detail ? { detail } : {}),
    });
  }
});

router.get("/import/chatgpt/:ref", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const ref = String(req.params.ref ?? "").trim();
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    const state = await getChatGptImportJobStatus(req.authContext!, ref);
    if (!state) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json(state);
  } catch (error) {
    console.error("Error fetching ChatGPT import status:", error);
    res.status(500).json({ error: "Failed to fetch ChatGPT import status" });
  }
});

router.post("/import/chatgpt/:ref/persist", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const ref = String(req.params.ref ?? "").trim();
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    const result = await persistChatGptImportJob(req.authContext!, ref);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      res.status(404).json({ error: message });
      return;
    }
    if (/preview|status|accepted/i.test(message)) {
      res.status(422).json({ error: message });
      return;
    }
    console.error("Error persisting ChatGPT import preview:", error);
    res.status(500).json({ error: "Failed to persist ChatGPT import preview" });
  }
});

router.get("/preferences", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const preferences = await listPreferences(req.authContext!);
    res.json({ preferences });
  } catch (error) {
    console.error("Error listing preferences:", error);
    res.status(500).json({ error: "Failed to list preferences" });
  }
});

router.delete("/preferences/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await forgetPreference(String(req.params.id), req.authContext!, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: "Preference not found" });
      return;
    }
    console.error("Error deleting preference:", error);
    res.status(500).json({ error: "Failed to delete preference" });
  }
});

router.get("/recall", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = recallSchema.parse(req.query);
    const result = await recallMemories(query.q, req.authContext!, query.limit, req.ip, {
      types: query.types,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error recalling memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

router.post("/cleanup/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = cleanupRunSchema.parse(req.body ?? {});
    const run = await runMemoryCleanupForUser(req.authContext!, {
      runReason: "manual",
      dryRun: body.dryRun ?? true,
      maxMemories: body.maxMemories,
      processAll: body.processAll ?? false,
      includeReviewed: body.includeReviewed ?? false,
      logImplicitKeeps: body.logImplicitKeeps ?? false,
      selectionStrategy: body.selectionStrategy ?? "newest_hybrid",
      newestLimit: body.newestLimit ?? 150,
      interestingLimit: body.interestingLimit ?? 50,
    });
    const adminEmail = body.emailAdmin === false
      ? { sent: false, skipped: true, to: null, error: "disabled by request" }
      : await sendMemoryCleanupAdminEmail({
          auth: req.authContext!,
          run,
          source: "manual",
        });
    res.status(201).json({ run, adminEmail });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error running memory cleanup:", error);
    res.status(500).json({ error: "Failed to run memory cleanup" });
  }
});

router.post("/cleanup/reset", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await resetMemoryCleanupReviewFlags(req.authContext!);
    res.json(result);
  } catch (error) {
    console.error("Error resetting memory cleanup review flags:", error);
    res.status(500).json({ error: "Failed to reset memory cleanup review flags" });
  }
});

router.get("/cleanup/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runs = await listMemoryCleanupRuns(req.authContext!);
    res.json({ runs });
  } catch (error) {
    console.error("Error listing memory cleanup runs:", error);
    res.status(500).json({ error: "Failed to list memory cleanup runs" });
  }
});

router.get("/cleanup/runs/:id", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const run = await getMemoryCleanupRun(req.authContext!, String(req.params.id));
    if (!run) {
      res.status(404).json({ error: "Memory cleanup run not found" });
      return;
    }
    res.json({ run });
  } catch (error) {
    console.error("Error reading memory cleanup run:", error);
    res.status(500).json({ error: "Failed to read memory cleanup run" });
  }
});

router.get("/cleanup/loop-miner/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runs = await listLoopMinerRunsForUser(req.authContext!);
    res.json({ runs });
  } catch (error) {
    console.error("Error listing loop miner runs:", error);
    res.status(500).json({ error: "Failed to list loop miner runs" });
  }
});

router.get("/cleanup/loop-miner/runs/:id/embedding-map", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runId = String(req.params.id);
    const map = await getLoopMinerRunEmbeddingMapForUser(req.authContext!, runId);
    if (!map) {
      res.status(404).json({ error: "Loop miner run not found" });
      return;
    }
    res.json({ map });
  } catch (error) {
    console.error("Error building loop miner embedding map:", error);
    res.status(500).json({ error: "Failed to build loop miner embedding map" });
  }
});

router.get("/cleanup/loop-miner/runs/:id/status", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runId = String(req.params.id);
    const status = await getLoopMinerRunStatusForUser(req.authContext!, runId);
    if (!status) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(status);
  } catch (error) {
    logger.error("loop miner run status request failed", { error });
    res.status(500).json({ error: "Failed to get loop miner run status" });
  }
});

router.get("/cleanup/loop-miner/runs/:id/status/stream", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  const runId = String(req.params.id);
  const maxStreamAgeMs = 10 * 60 * 1000;
  const streamStartedAt = Date.now();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  let closed = false;
  let polling = false;

  const poll = async (): Promise<boolean> => {
    if (polling) return false;
    polling = true;
    try {
      if (Date.now() - streamStartedAt > maxStreamAgeMs) {
        send({ error: "Loop miner status stream timed out" });
        return true;
      }
      const status = await getLoopMinerRunStatusForUser(req.authContext!, runId);
      if (!status) {
        send({ error: "Run not found" });
        return true;
      }
      send(status);
      return status.status !== "running";
    } catch (error) {
      logger.error("loop miner status stream poll failed", { runId, error });
      return true;
    } finally {
      polling = false;
    }
  };

  const done = await poll();
  if (done || closed) {
    res.end();
    return;
  }

  const interval = setInterval(async () => {
    if (closed) {
      clearInterval(interval);
      return;
    }
    const done = await poll();
    if (done) {
      clearInterval(interval);
      res.end();
    }
  }, 2000);

  req.on("close", () => {
    closed = true;
    clearInterval(interval);
  });
});

router.post("/cleanup/loop-miner/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = loopMinerRunSchema.parse(req.body ?? {});
    logger.info("loop miner run requested", {
      userId: req.authContext?.userId,
      tenantId: req.authContext?.tenantId,
      lookbackDays: body.lookbackDays ?? 30,
    });

    const existingRuns = await listLoopMinerRunsForUser(req.authContext!, 5);
    const now = Date.now();
    const activeRun = existingRuns.find((run) => {
      if (run.status !== "running") return false;
      const ageMs = now - Date.parse(run.createdAt);
      return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < LOOP_MINER_STALE_RUNNING_MAX_AGE_MS;
    }) ?? null;
    if (activeRun) {
      res.status(202).json({
        run: activeRun,
        queued: false,
        message: "Loop miner run already in progress. Slack will notify when it finishes; refresh this page to update.",
      });
      return;
    }

    const run = await queueLoopMinerRunForUser(req.authContext!, {
      runReason: "manual",
      lookbackDays: body.lookbackDays ?? 30,
      processAll: body.processAll ?? true,
      memoryNewestLimit: body.memoryNewestLimit,
      memoryInterestingLimit: body.memoryInterestingLimit,
    });
    logger.info("loop miner run queued response", {
      runId: run?.id ?? null,
      status: run?.status ?? null,
    });
    res.status(202).json({
      run: run ?? null,
      queued: true,
      message: "Loop miner run queued. Slack will notify when it finishes; refresh this page to update.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logger.error("loop miner run request failed", {
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    });
    res.status(500).json({
      error: "Failed to run loop miner",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = listSchema.parse(req.query);
    const page = await listMemoriesPage(req.authContext!, {
      limit: query.limit,
      offset: query.offset,
    });
    res.json({
      memories: page.memories,
      pagination: {
        limit: page.limit,
        offset: page.offset,
        total: page.total ?? page.memories.length,
        hasMore: page.hasMore,
        nextOffset: page.hasMore ? page.offset + page.memories.length : null,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error listing memories:", error);
    res.status(500).json({ error: "Failed to list memories" });
  }
});


router.delete("/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await deleteMemory(String(req.params.id), req.authContext!, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found|not owned/i.test(error.message)) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    console.error("Error deleting memory:", error);
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

export default router;

import JSZip from "jszip";

export type BulkJsonRole =
  | "conversations"
  | "shared_conversations"
  | "profile"
  | "other_json"
  | "dat_text"
  | "dat_metadata"
  | "library_catalog";

export interface BulkIngestDocument {
  path: string;
  role: BulkJsonRole;
  data: unknown;
}

export interface BulkIngestSkipped {
  binaryDat: number;
  binaryDatSamples: string[];
  libraryCatalog: number;
  other: number;
  otherSamples: string[];
}

export interface BulkDatInspectionSummary {
  inspected: number;
  extracted: number;
  extractedSamples: string[];
  metadataOnly: number;
  metadataSamples: string[];
  skipped: number;
}

export interface BulkIngestSummary {
  sourcesParsed: string[];
  skipped: BulkIngestSkipped;
  dat: BulkDatInspectionSummary;
  hasConversationsJson: boolean;
  skippedDatFiles?: number;
  skippedMediaFiles?: number;
  skippedOtherBinary?: number;
  skippedOldConversations?: number;
}

export interface BulkIngestResult {
  documents: BulkIngestDocument[];
  sourcesParsed: string[];
  skipped: BulkIngestSkipped;
  dat: BulkDatInspectionSummary;
  warnings: string[];
  hasConversationsJson: boolean;
}

export function toBulkIngestSummary(result: BulkIngestResult): BulkIngestSummary {
  return {
    sourcesParsed: result.sourcesParsed,
    skipped: result.skipped,
    dat: result.dat,
    hasConversationsJson: result.hasConversationsJson,
  };
}

export interface BulkIngestFile {
  name: string;
  buffer: Buffer;
}

const CONVERSATIONS_JSON = /^conversations(?:-\d+)?\.json$/i;
const SHARED_CONVERSATIONS_JSON = /^shared_conversations\.json$/i;
const PROFILE_JSON = /^(user|user_settings)\.json$/i;
const LIBRARY_FILES_JSON = /^library_files\.json$/i;
const SKIP_JSON = /^(message_feedback|model_comparisons|chat)\./i;
const DAT_TEXT_MAX_CHARS = 8_000;
const DAT_TOPIC_STOPWORDS = new Set([
  "dat",
  "file",
  "files",
  "asset",
  "assets",
  "conversation",
  "conversations",
  "shared",
  "user",
  "settings",
  "library",
  "export",
  "chatgpt",
  "openai",
]);

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? path;
}

function classifyEntry(path: string): "conversations" | "shared_conversations" | "profile" | "library" | "binary_dat" | "skip" | "other_json" {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".dat")) return "binary_dat";
  if (CONVERSATIONS_JSON.test(name)) return "conversations";
  if (SHARED_CONVERSATIONS_JSON.test(name)) return "shared_conversations";
  if (PROFILE_JSON.test(name)) return "profile";
  if (LIBRARY_FILES_JSON.test(name)) return "library";
  if (name.endsWith(".json") && !SKIP_JSON.test(name)) return "other_json";
  if (name.endsWith(".jsonl") || name.endsWith(".txt")) return "other_json";
  if (name.endsWith(".html")) return "skip";
  return "skip";
}

function looksBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let controlBytes = 0;
  let zeroBytes = 0;
  for (const byte of sample) {
    if (byte === 0) zeroBytes += 1;
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl) controlBytes += 1;
  }
  if (zeroBytes > 0) return true;
  if (controlBytes / sample.length > 0.08) return true;
  const text = sample.toString("utf8");
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  return replacementChars / text.length > 0.02;
}

function decodeDatText(buffer: Buffer): string | null {
  const decoded = buffer.toString("utf8").replace(/\u0000/g, "").trim();
  if (!decoded) return null;
  const compact = decoded.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= DAT_TEXT_MAX_CHARS) return compact;
  return `${compact.slice(0, DAT_TEXT_MAX_CHARS)}...`;
}

function inferDatTopics(path: string, content?: string | null): string[] {
  const base = basename(path).toLowerCase();
  const seed = `${base} ${content ?? ""}`;
  const tokens = seed
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !DAT_TOPIC_STOPWORDS.has(token));
  const unique = [...new Set(tokens)];
  return unique.slice(0, 6);
}

function parseJsonBuffer(buffer: Buffer, path: string): unknown {
  const decoded = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!decoded) throw new Error(`File "${path}" is empty.`);
  if (basename(path).toLowerCase().endsWith(".jsonl")) {
    const rows = decoded
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    return rows;
  }
  return JSON.parse(decoded) as unknown;
}

function pushSample(samples: string[], path: string, max = 5): void {
  if (samples.length >= max) return;
  samples.push(basename(path));
}

function ingestBuffer(path: string, buffer: Buffer, result: BulkIngestResult): void {
  const kind = classifyEntry(path);
  switch (kind) {
    case "binary_dat": {
      result.dat.inspected += 1;
      if (looksBinaryBuffer(buffer)) {
        const topics = inferDatTopics(path, null);
        result.documents.push({
          path: basename(path),
          role: "dat_metadata",
          data: {
            path: basename(path),
            topics,
            extracted: false,
          },
        });
        result.dat.metadataOnly += 1;
        pushSample(result.dat.metadataSamples, path);
        result.skipped.binaryDat += 1;
        pushSample(result.skipped.binaryDatSamples, path);
        return;
      }
      const text = decodeDatText(buffer);
      if (!text) {
        result.dat.skipped += 1;
        result.skipped.binaryDat += 1;
        pushSample(result.skipped.binaryDatSamples, path);
        return;
      }
      result.documents.push({
        path: basename(path),
        role: "dat_text",
        data: {
          path: basename(path),
          text,
          topics: inferDatTopics(path, text),
          extracted: true,
        },
      });
      result.sourcesParsed.push(basename(path));
      result.dat.extracted += 1;
      pushSample(result.dat.extractedSamples, path);
      return;
    }
    case "library":
      try {
        const data = parseJsonBuffer(buffer, path);
        result.documents.push({ path: basename(path), role: "library_catalog", data });
        result.sourcesParsed.push(basename(path));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON";
        result.warnings.push(`Skipped "${basename(path)}": ${message}`);
        result.skipped.libraryCatalog += 1;
      }
      return;
    case "skip":
      result.skipped.other += 1;
      pushSample(result.skipped.otherSamples, path);
      return;
    case "conversations":
    case "shared_conversations":
    case "profile":
    case "other_json": {
      if (looksBinaryBuffer(buffer)) {
        result.skipped.binaryDat += 1;
        pushSample(result.skipped.binaryDatSamples, path);
        return;
      }
      try {
        const data = parseJsonBuffer(buffer, path);
        const role: BulkJsonRole =
          kind === "conversations"
            ? "conversations"
            : kind === "shared_conversations"
              ? "shared_conversations"
              : kind === "profile"
                ? "profile"
                : "other_json";
        result.documents.push({ path: basename(path), role, data });
        result.sourcesParsed.push(basename(path));
        if (kind === "conversations") result.hasConversationsJson = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON";
        result.warnings.push(`Skipped "${basename(path)}": ${message}`);
        result.skipped.other += 1;
        pushSample(result.skipped.otherSamples, path);
      }
      return;
    }
    default:
      result.skipped.other += 1;
      pushSample(result.skipped.otherSamples, path);
  }
}

async function ingestZipBuffer(buffer: Buffer, result: BulkIngestResult): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  for (const entry of entries) {
    const content = await entry.async("nodebuffer");
    ingestBuffer(entry.name, content, result);
  }
}

function finalizeWarnings(result: BulkIngestResult): BulkIngestResult {
  if (result.dat.inspected > 0) {
    result.warnings.push(
      `Inspected ${result.dat.inspected} .dat file(s): extracted=${result.dat.extracted}, metadata-only=${result.dat.metadataOnly}, skipped=${result.dat.skipped}.`
    );
  } else if (result.skipped.binaryDat > 0) {
    result.warnings.push(
      `Skipped ${result.skipped.binaryDat} binary .dat file(s) (images, audio, uploads — not memory text).`
    );
  }
  if (result.skipped.libraryCatalog > 0) {
    result.warnings.push(
      `Skipped ${result.skipped.libraryCatalog} library catalog file(s) (library_files.json).`
    );
  }
  if (!result.hasConversationsJson && result.documents.length > 0) {
    result.warnings.push(
      "No conversations.json found in this archive. Only partial data (e.g. shared_conversations.json) will be imported. For full chat history, re-export from ChatGPT Settings → Data Controls → Export."
    );
  }
  if (result.documents.length === 0 && result.skipped.binaryDat > 0 && result.sourcesParsed.length === 0) {
    result.warnings.push(
      "No importable JSON found. Upload your ChatGPT data export ZIP or conversations.json — not individual .dat media files."
    );
  }
  return result;
}

export function createEmptyBulkIngestResult(): BulkIngestResult {
  return {
    documents: [],
    sourcesParsed: [],
    skipped: {
      binaryDat: 0,
      binaryDatSamples: [],
      libraryCatalog: 0,
      other: 0,
      otherSamples: [],
    },
    dat: {
      inspected: 0,
      extracted: 0,
      extractedSamples: [],
      metadataOnly: 0,
      metadataSamples: [],
      skipped: 0,
    },
    warnings: [],
    hasConversationsJson: false,
  };
}

export async function ingestChatGptBulkFiles(files: BulkIngestFile[]): Promise<BulkIngestResult> {
  const result = createEmptyBulkIngestResult();

  for (const file of files) {
    const name = file.name.trim();
    const lower = name.toLowerCase();
    if (lower.endsWith(".zip")) {
      await ingestZipBuffer(file.buffer, result);
      continue;
    }
    ingestBuffer(name, file.buffer, result);
  }

  return finalizeWarnings(result);
}

export function ingestChatGptBulkFromBuffers(files: BulkIngestFile[]): Promise<BulkIngestResult> {
  return ingestChatGptBulkFiles(files);
}

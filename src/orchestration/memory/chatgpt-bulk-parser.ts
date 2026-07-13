import type { BulkIngestDocument } from "./chatgpt-bulk-ingest.js";

export interface BulkMemoryCandidate {
  text: string;
  sourceDateTime: string | null;
  sourceFile: string;
}

export interface BulkParseResult {
  candidates: BulkMemoryCandidate[];
  conversationCount: number;
  warnings: string[];
}

export interface BulkConversationBundle {
  id: string;
  sourceFile: string;
  sourceDateTime: string | null;
  title: string | null;
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    sourceDateTime: string | null;
  }>;
}

const BULK_EXPORT_MAX_CANDIDATES = 5_000;
const MAX_PER_CONVERSATION = 10;
const MAX_LINE_LENGTH = 500;
const MIN_LINE_LENGTH = 12;

const MEMORY_HEURISTIC =
  /\b(?:i\s+(?:prefer|like|use|work|live|am|want|need|always|never)|my\s+(?:name|timezone|email|role|job|team|company)|remember\s+that|please\s+remember|call\s+me)\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function readSourceDateTime(item: unknown): string | null {
  const row = asRecord(item);
  if (!row) return null;
  for (const key of [
    "datetime",
    "dateTime",
    "create_time",
    "created_at",
    "createdAt",
    "update_time",
    "updated_at",
    "timestamp",
  ]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return normalizeWhitespace(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      const asMs = value > 1e12 ? value : value * 1000;
      const date = new Date(asMs);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

export function readSourceDateTimeFromRecord(item: unknown): string | null {
  return readSourceDateTime(item);
}

export function isConversationWithinImportWindow(
  value: unknown,
  maxAgeDays: number | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (maxAgeDays == null || maxAgeDays <= 0) {
    return asRecord(record["mapping"]) != null;
  }
  const dt = readSourceDateTime(record);
  if (!dt) return false;
  const parsed = Date.parse(dt);
  if (Number.isNaN(parsed)) return false;
  return parsed >= nowMs - maxAgeDays * 86_400_000;
}

function messagePartToText(part: unknown): string[] {
  if (typeof part === "string") return [part];
  const record = asRecord(part);
  if (!record) return [];
  if (
    record["asset_pointer"]
    || record["image_url"]
    || record["audio"]
    || record["file"]
    || record["image"]
    || record["video"]
  ) {
    return [];
  }
  if (typeof record["content_type"] === "string") {
    const ct = record["content_type"].toLowerCase();
    if (["image", "audio", "video", "file", "image_file", "audio_file"].includes(ct)) return [];
  }
  const text = record["text"];
  if (typeof text === "string") return [text];
  const segments = record["segments"];
  if (Array.isArray(segments)) {
    return segments.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function isAllowedContentType(contentType: unknown): boolean {
  if (typeof contentType !== "string") return true;
  const normalized = contentType.toLowerCase();
  if (normalized === "text" || normalized === "multimodal_text" || normalized === "") return true;
  if (["image", "audio", "video", "file", "code", "image_file", "audio_file"].includes(normalized)) {
    return false;
  }
  return false;
}

function isAttachmentPlaceholderLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^\[(?:image|audio|video|file|attachment)\]$/i.test(trimmed)) return true;
  if (/^file-[\w-]+\.(?:png|jpg|jpeg|webp|gif|mp3|mp4|wav|pdf)$/i.test(trimmed)) return true;
  return false;
}

export function looksLikeBinaryText(text: string): boolean {
  if (text.includes("RIFF") && /WAVE|WEBP|PNG/i.test(text)) return true;
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (text.length > 20 && replacement / text.length > 0.05) return true;
  const control = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) ?? []).length;
  return control > 2;
}

function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^```/.test(trimmed)) return true;
  if (/\b(?:select|from|join|where|group by|order by|insert into|update|delete from|values|create table|alter table)\b/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z_$][\w$.-]{1,40}\s*:\s*(?:['"`\[{(]|https?:\/\/|true|false|null|\d|new\s|await\s)/.test(trimmed)) {
    return true;
  }
  if ((trimmed.match(/:\s/g) ?? []).length >= 2 && /[A-Za-z_$]/.test(trimmed)) {
    return true;
  }
  if (/^\s*(?:import|export|const|let|var|function|class|interface|type|return|await)\b/.test(trimmed)) {
    return true;
  }
  if (/=>/.test(trimmed) && /[{}();=]/.test(trimmed)) return true;
  if (/^[A-Za-z_$][\w$]*\s*[:=]\s*[{[(]/.test(trimmed)) return true;
  if (/(?:\b[\w.-]+:\s+){3,}/.test(trimmed)) return true;
  if (/^(?:\/\*|\*\/|\* )/.test(trimmed)) return true;

  const punct = (trimmed.match(/[{}[\];()<>]/g) ?? []).length;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  return punct >= 3 && letters > 0 && punct / (punct + letters) > 0.2;
}

function splitLongLine(line: string): string[] {
  if (line.length <= 360) return [line];
  return line
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= MIN_LINE_LENGTH && part.length <= 280);
}

function sanitizeLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= MIN_LINE_LENGTH && line.length <= MAX_LINE_LENGTH)
    .filter((line) => !/^[`"'[\]{}()<>]+$/.test(line))
    .filter((line) => !looksLikeBinaryText(line))
    .filter((line) => !isAttachmentPlaceholderLine(line))
    .filter((line) => !looksLikeCodeLine(line))
    .flatMap((line) => splitLongLine(line));
}

function sanitizeLinesAllowShort(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 2 && line.length <= MAX_LINE_LENGTH)
    .filter((line) => !/^[`"'[\]{}()<>]+$/.test(line))
    .filter((line) => !looksLikeBinaryText(line))
    .flatMap((line) => splitLongLine(line));
}

function scoreMemoryLine(line: string): number {
  if (looksLikeCodeLine(line)) return -100;
  let score = 0;
  if (MEMORY_HEURISTIC.test(line)) score += 4;
  if (/^i\s+/i.test(line)) score += 1;
  if (/\bprefer\b|\btimezone\b|\bremember\b/i.test(line)) score += 2;
  const isQuestion = /[?.]/.test(line) && /\b(?:how|what|why|can|should|would|is|are|do|did|does)\b/i.test(line);
  if (isQuestion) {
    if (/\b(i am|i'm building|our product|my company|we use|our stack)\b/i.test(line)) {
      score += 1;
    } else {
      score -= 1;
    }
  }
  if (line.length >= 20 && line.length <= 240) score += 1;
  return score;
}

function pickConversationLines(lines: string[]): string[] {
  const scored = lines
    .map((line, index) => ({ line, index, score: scoreMemoryLine(line) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (scored.length > 0) {
    return scored
      .slice(0, MAX_PER_CONVERSATION)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.line);
  }

  return [];
}

function buildActivePath(
  mapping: Record<string, unknown>,
  currentNodeId: string | null
): string[] {
  if (currentNodeId && mapping[currentNodeId]) {
    const path: string[] = [];
    let cur: string | null = currentNodeId;
    const guard = new Set<string>();
    while (cur && mapping[cur] && !guard.has(cur)) {
      guard.add(cur);
      path.unshift(cur);
      const node = asRecord(mapping[cur]);
      const parent = node?.["parent"];
      cur = typeof parent === "string" ? parent : null;
    }
    if (path.length > 0) return path;
  }

  const roots = Object.entries(mapping).filter(([, node]) => {
    const record = asRecord(node);
    return record && (record["parent"] === null || record["parent"] === undefined);
  });

  if (roots.length === 0) return Object.keys(mapping);

  const path: string[] = [];
  let cur: string | null = roots[0]?.[0] ?? null;
  const guard = new Set<string>();
  while (cur && mapping[cur] && !guard.has(cur)) {
    guard.add(cur);
    path.push(cur);
    const node = asRecord(mapping[cur]);
    const children = Array.isArray(node?.["children"]) ? (node["children"] as unknown[]) : [];
    const next = children.find((child): child is string => typeof child === "string");
    cur = next ?? null;
  }
  return path;
}

function extractUserLinesFromNode(
  node: Record<string, unknown>,
  fallbackDateTime: string | null
): string[] {
  const message = asRecord(node["message"]);
  if (!message) return [];
  const author = asRecord(message["author"]);
  const role = typeof author?.["role"] === "string" ? author["role"].toLowerCase() : "";
  if (role && role !== "user") return [];

  const content = asRecord(message["content"]);
  if (!content) return [];
  if (!isAllowedContentType(content["content_type"])) return [];

  const sourceDateTime = readSourceDateTime(message) ?? fallbackDateTime;
  const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
  const lines: string[] = [];
  for (const part of parts) {
    for (const text of messagePartToText(part)) {
      lines.push(...sanitizeLines(text));
    }
  }
  void sourceDateTime;
  return lines;
}

function extractFromConversation(
  convo: Record<string, unknown>,
  sourceFile: string
): BulkMemoryCandidate[] {
  const mapping = asRecord(convo["mapping"]);
  if (!mapping) return [];

  const convoDateTime = readSourceDateTime(convo);
  const currentNodeId = typeof convo["current_node"] === "string" ? convo["current_node"] : null;
  const path = buildActivePath(mapping, currentNodeId);
  const allLines: string[] = [];

  for (const nodeId of path) {
    const node = asRecord(mapping[nodeId]);
    if (!node) continue;
    allLines.push(...extractUserLinesFromNode(node, convoDateTime));
  }

  const picked = pickConversationLines(allLines);
  if (picked.length === 0) return [];
  return [{
    text: picked.join("\n"),
    sourceDateTime: convoDateTime,
    sourceFile,
  }];
}

function extractMessagesFromNode(
  node: Record<string, unknown>,
  fallbackDateTime: string | null
): Array<{ role: "user" | "assistant"; text: string; sourceDateTime: string | null }> {
  const message = asRecord(node["message"]);
  if (!message) return [];
  const author = asRecord(message["author"]);
  const roleRaw = typeof author?.["role"] === "string" ? author["role"].toLowerCase() : "";
  if (roleRaw !== "user" && roleRaw !== "assistant") return [];

  const content = asRecord(message["content"]);
  if (!content) return [];
  if (!isAllowedContentType(content["content_type"])) return [];

  const sourceDateTime = readSourceDateTime(message) ?? fallbackDateTime;
  const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
  const lines: string[] = [];
  for (const part of parts) {
    for (const text of messagePartToText(part)) {
      lines.push(...sanitizeLinesAllowShort(text));
    }
  }
  if (lines.length === 0) return [];
  return [{
    role: roleRaw,
    text: lines.join("\n"),
    sourceDateTime,
  }];
}

function claudeMessageToRole(sender: unknown): "user" | "assistant" | null {
  if (typeof sender !== "string") return null;
  const normalized = sender.trim().toLowerCase();
  if (normalized === "human" || normalized === "user") return "user";
  if (normalized === "assistant" || normalized === "bot") return "assistant";
  return null;
}

function claudeMessageToText(message: Record<string, unknown>): string {
  const text = message["text"];
  if (typeof text === "string" && text.trim().length > 0) return text;
  const content = message["content"];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (typeof entry === "string") {
        parts.push(entry);
        continue;
      }
      const row = asRecord(entry);
      if (!row) continue;
      const blockText = row["text"];
      if (typeof blockText === "string" && blockText.trim().length > 0) {
        parts.push(blockText);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

export function isClaudeConversationRecord(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const chatMessages = record["chat_messages"];
  return Array.isArray(chatMessages) && chatMessages.length > 0;
}

function claudeRecordToBundle(
  record: Record<string, unknown>,
  sourceFile: string,
  rootIndex: number
): BulkConversationBundle | null {
  const chatMessages = Array.isArray(record["chat_messages"]) ? record["chat_messages"] : null;
  if (!chatMessages || chatMessages.length === 0) return null;

  const convoDateTime = readSourceDateTime(record);
  const messages: Array<{ role: "user" | "assistant"; text: string; sourceDateTime: string | null }> = [];

  for (const item of chatMessages) {
    const row = asRecord(item);
    if (!row) continue;
    const role = claudeMessageToRole(row["sender"]);
    if (!role) continue;
    const text = claudeMessageToText(row);
    const sanitized = sanitizeLinesAllowShort(text);
    if (sanitized.length === 0) continue;
    messages.push({
      role,
      text: sanitized.join("\n"),
      sourceDateTime: readSourceDateTime(row) ?? convoDateTime,
    });
  }

  if (messages.length === 0) return null;

  const title = typeof record["name"] === "string" && record["name"].trim().length > 0
    ? record["name"].trim()
    : typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"].trim()
      : null;

  const id = typeof record["uuid"] === "string" && record["uuid"].trim().length > 0
    ? record["uuid"].trim()
    : typeof record["id"] === "string" && record["id"].trim().length > 0
      ? record["id"].trim()
      : `${sourceFile}:${rootIndex}`;

  return {
    id,
    sourceFile,
    sourceDateTime: convoDateTime,
    title,
    messages,
  };
}

export function extractClaudeConversationBundles(
  data: unknown,
  sourceFile: string
): BulkConversationBundle[] {
  const bundles: BulkConversationBundle[] = [];
  const roots = Array.isArray(data) ? data : [data];

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const record = asRecord(roots[rootIndex]);
    if (!record) continue;

    if (isClaudeConversationRecord(record)) {
      const bundle = claudeRecordToBundle(record, sourceFile, rootIndex);
      if (bundle) bundles.push(bundle);
      continue;
    }

    const nested = record["conversations"];
    if (Array.isArray(nested)) {
      for (let nestedIndex = 0; nestedIndex < nested.length; nestedIndex += 1) {
        const nestedRecord = asRecord(nested[nestedIndex]);
        if (!nestedRecord || !isClaudeConversationRecord(nestedRecord)) continue;
        const bundle = claudeRecordToBundle(nestedRecord, sourceFile, rootIndex * 1000 + nestedIndex);
        if (bundle) bundles.push(bundle);
      }
    }
  }

  return bundles;
}

function collectConversationBundlesFromPayload(data: unknown, sourceFile: string): BulkConversationBundle[] {
  const claudeBundles = extractClaudeConversationBundles(data, sourceFile);
  if (claudeBundles.length > 0) return claudeBundles;

  const bundles: BulkConversationBundle[] = [];
  const roots = Array.isArray(data) ? data : [data];

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const bundle = conversationRecordToBundle(roots[rootIndex], sourceFile, rootIndex);
    if (bundle) bundles.push(bundle);
  }

  return bundles;
}

export function conversationRecordToBundle(
  root: unknown,
  sourceFile: string,
  rootIndex: number
): BulkConversationBundle | null {
  const record = asRecord(root);
  if (!record) return null;

  if (isClaudeConversationRecord(record)) {
    return claudeRecordToBundle(record, sourceFile, rootIndex);
  }

  const mapping = asRecord(record["mapping"]);
  if (!mapping) return null;
  const convoDateTime = readSourceDateTime(record);
  const currentNodeId = typeof record["current_node"] === "string" ? record["current_node"] : null;
  const path = buildActivePath(mapping, currentNodeId);

  const messages: Array<{ role: "user" | "assistant"; text: string; sourceDateTime: string | null }> = [];
  for (const nodeId of path) {
    const node = asRecord(mapping[nodeId]);
    if (!node) continue;
    messages.push(...extractMessagesFromNode(node, convoDateTime));
  }
  if (messages.length === 0) return null;

  const title = typeof record["title"] === "string" && record["title"].trim().length > 0
    ? record["title"].trim()
    : null;

  return {
    id: `${sourceFile}:${rootIndex}`,
    sourceFile,
    sourceDateTime: convoDateTime,
    title,
    messages,
  };
}

function collectConversationsFromPayload(data: unknown, sourceFile: string): BulkMemoryCandidate[] {
  const candidates: BulkMemoryCandidate[] = [];
  const roots = Array.isArray(data) ? data : [data];
  for (const root of roots) {
    const record = asRecord(root);
    if (!record) continue;
    if (asRecord(record["mapping"])) {
      candidates.push(...extractFromConversation(record, sourceFile));
      continue;
    }
    if (Array.isArray(record["conversations"])) {
      for (const item of record["conversations"]) {
        const convo = asRecord(item);
        if (convo) candidates.push(...extractFromConversation(convo, sourceFile));
      }
    }
  }
  return candidates;
}

export function extractProfileImportItems(data: unknown, sourceFile: string): BulkMemoryCandidate[] {
  return collectProfileCandidates(data, sourceFile);
}

function collectProfileCandidates(data: unknown, sourceFile: string): BulkMemoryCandidate[] {
  const record = asRecord(data);
  if (!record) return [];
  const candidates: BulkMemoryCandidate[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value.trim().length < MIN_LINE_LENGTH) continue;
    if (/^(id|email|phone|avatar|picture|token)/i.test(key)) continue;
    const line = normalizeWhitespace(`${key}: ${value}`);
    if (!looksLikeBinaryText(line)) {
      candidates.push({ text: line, sourceDateTime: null, sourceFile });
    }
  }
  return candidates.slice(0, 10);
}

function collectDatTextCandidates(data: unknown, sourceFile: string): BulkMemoryCandidate[] {
  const row = asRecord(data);
  if (!row) return [];
  const text = typeof row["text"] === "string" ? row["text"] : null;
  if (!text) return [];
  const lines = sanitizeLines(text);
  if (lines.length === 0) return [];
  return [{
    text: lines.join("\n"),
    sourceDateTime: null,
    sourceFile,
  }];
}

function collectDatMetadataCandidates(data: unknown, sourceFile: string): BulkMemoryCandidate[] {
  const row = asRecord(data);
  if (!row) return [];
  const topics = Array.isArray(row["topics"])
    ? row["topics"].filter((entry): entry is string => typeof entry === "string").slice(0, 6)
    : [];
  if (topics.length === 0) return [];
  return [{
    text: `dat_topics: ${topics.join(", ")}`,
    sourceDateTime: null,
    sourceFile,
  }];
}

export function extractBulkMemoryCandidates(documents: BulkIngestDocument[]): BulkParseResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const candidates: BulkMemoryCandidate[] = [];
  let conversationCount = 0;

  for (const doc of documents) {
    if (doc.role === "conversations" || doc.role === "shared_conversations") {
      const convoRoots = Array.isArray(doc.data) ? doc.data.length : asRecord(doc.data)?.["mapping"] ? 1 : 0;
      conversationCount += convoRoots;
      const rows = collectConversationsFromPayload(doc.data, doc.path);
      for (const row of rows) {
        const key = row.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(row);
      }
      continue;
    }
    if (doc.role === "profile") {
      for (const row of collectProfileCandidates(doc.data, doc.path)) {
        const key = row.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(row);
      }
      continue;
    }
    if (doc.role === "dat_text") {
      for (const row of collectDatTextCandidates(doc.data, doc.path)) {
        const key = row.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(row);
      }
      continue;
    }
    if (doc.role === "dat_metadata") {
      for (const row of collectDatMetadataCandidates(doc.data, doc.path)) {
        const key = row.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(row);
      }
    }
  }

  let capped = candidates;
  if (candidates.length > BULK_EXPORT_MAX_CANDIDATES) {
    warnings.push(
      `Capped bulk export candidates at ${BULK_EXPORT_MAX_CANDIDATES} from ${candidates.length} detected rows.`
    );
    capped = candidates.slice(0, BULK_EXPORT_MAX_CANDIDATES);
  }

  return {
    candidates: capped,
    conversationCount,
    warnings,
  };
}

export function extractBulkConversationBundles(documents: BulkIngestDocument[]): BulkConversationBundle[] {
  const bundles: BulkConversationBundle[] = [];
  for (const doc of documents) {
    if (doc.role !== "conversations" && doc.role !== "shared_conversations") continue;
    bundles.push(...collectConversationBundlesFromPayload(doc.data, doc.path));
  }
  return bundles;
}

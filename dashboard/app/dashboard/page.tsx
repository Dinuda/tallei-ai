"use client";

import Image from "next/image";
import {
  ChevronDown,
  Clock,
  Copy,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { EmptyCollectionState } from "./components/empty-collection-state";
import styles from "./page.module.css";

type MemoryItem = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type Platform = "claude" | "chatgpt" | "gemini" | "other";
type MemoryType =
  | "preference"
  | "fact"
  | "event"
  | "decision"
  | "note"
  | "lesson"
  | "failure"
  | "checkpoint"
  | "collab"
  | "unknown";

type UIMemory = MemoryItem & {
  platform: Platform;
  memoryType: MemoryType;
  category: string;
  keywords: string[];
  importance: number;
};

type TimeFilter = "all" | "1d" | "7d" | "30d";
type MessageKind = "success" | "error" | "info";

type ModalMessage = {
  kind: MessageKind;
  text: string;
};

type PaginationState = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

type MemoriesResponsePayload = {
  memories?: MemoryItem[];
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
    hasMore?: boolean;
  };
  error?: string;
};

type ChatGptImportCandidate = {
  raw: string;
  normalized: string;
  detectedKey: string | null;
  detectedValue: string;
  sourceDateTime: string | null;
  memoryType: MemoryType;
  category: string | null;
  isPinned: boolean;
  preferenceKey: string | null;
  status: "accepted" | "duplicate" | "conflict" | "invalid";
  reason?: string;
  extractConfidence?: number;
  extractStability?: number;
  extractType?: string;
  sourceReason?: string;
};

type ChatGptImportConflict = {
  reason: "contradictory_value";
  candidate: {
    raw: string;
    memoryType: MemoryType;
    category: string | null;
    isPinned: boolean;
    entityKey: string;
    sourceDateTime: string | null;
    preferenceKey: string | null;
    detectedKey: string | null;
    detectedValue: string;
  };
  existing: {
    memoryId: string;
    text: string;
    memoryType: MemoryType;
    preferenceKey: string | null;
    category: string | null;
    detectedValue: string;
  };
};

type ChatGptImportDuplicate = {
  reason: string;
  candidate: {
    raw: string;
    normalized: string;
    sourceDateTime: string | null;
    memoryType: MemoryType;
    category: string | null;
    preferenceKey: string | null;
    detectedKey: string | null;
  };
  existingMemoryId?: string;
};

type ChatGptIngestSummary = {
  sourcesParsed: string[];
  skipped: {
    binaryDat: number;
    binaryDatSamples: string[];
    libraryCatalog: number;
    other: number;
    otherSamples: string[];
  };
  dat?: {
    inspected: number;
    extracted: number;
    extractedSamples: string[];
    metadataOnly: number;
    metadataSamples: string[];
    skipped: number;
  };
  hasConversationsJson: boolean;
  skippedDatFiles?: number;
  skippedMediaFiles?: number;
  skippedOtherBinary?: number;
  skippedOldConversations?: number;
};

type ChatGptImportResult = {
  batchId: string;
  mode: "json_export" | "paste" | "bulk_export";
  summary: {
    parsed: number;
    selected: number;
    skipped: number;
    hardDropped: number;
    keepHigh: number;
    keepWeak: number;
    dropped: number;
    extracted: number;
    accepted: number;
    duplicates: number;
    conflicts: number;
    invalid: number;
    persisted: number;
    embedded: number;
  };
  preview: ChatGptImportCandidate[];
  conflicts: ChatGptImportConflict[];
  duplicates: ChatGptImportDuplicate[];
  warnings: string[];
  ingestSummary?: ChatGptIngestSummary;
};

type ChatGptImportJobStatus = "pending" | "processing" | "done" | "failed";

type ChatGptImportJobState = {
  ref: string;
  status: ChatGptImportJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
  progress?: {
    stage?: "queued" | "ingesting" | "filtering" | "aggregating" | "extracting" | "promoting" | "persisting" | "processing" | "complete" | "failed";
    message?: string;
    summary?: ChatGptImportResult["summary"];
  } | null;
  result?: ChatGptImportResult | null;
  error?: { message: string } | null;
};

const BULK_IMPORT_ACCEPT = ".json,application/json";
const MAX_CONVERSATION_JSON_FILES = 50;

const CONVERSATION_JSON_FILENAME = /^conversations(?:-\d+)?\.json$/i;
const OPTIONAL_PROFILE_JSON_FILENAME = /^(shared_conversations|user|user_settings)\.json$/i;

function fileBasename(name: string): string {
  const normalized = name.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function conversationJsonImportBasename(file: File): string {
  return fileBasename(file.webkitRelativePath || file.name);
}

function isConversationJsonImportFile(file: File): boolean {
  const name = conversationJsonImportBasename(file);
  return CONVERSATION_JSON_FILENAME.test(name) || OPTIONAL_PROFILE_JSON_FILENAME.test(name);
}

function isConversationStreamFile(file: File): boolean {
  const name = conversationJsonImportBasename(file);
  return CONVERSATION_JSON_FILENAME.test(name) || /^shared_conversations\.json$/i.test(name);
}

function isBulkUploadFile(file: File): boolean {
  return isConversationJsonImportFile(file);
}

const CHATGPT_MEMORY_EXPORT_PROMPT = `Extract memory-relevant facts from this chat and return ONLY a JSON array of objects.

Goal: capture what the user actually does repeatedly — especially the underlying operational work that could be automated — not brainstorming sessions, future promises, or surface-level deliverables.

Prioritize recurring work the user performs (or clearly performs on a cadence):
1) Upstream preparation before any output exists: research, structure audits, topic sourcing, competitor scans, outline validation, context gathering.
2) Stable repeated action patterns: same job-to-be-done, same artifact type, same sources/tools — even when titles, week numbers, or wording change.
3) Operating cadence and checklists: weekly reviews, pre-publish steps, pre-meeting prep, recurring validation gates.
4) Domain scaffolding the user must establish before work can repeat: course structure (weeks/modules), newsletter format and product positioning, content pillars, approval flows.

Deprioritize or skip:
- Brainstorming, ideation, or planning sessions with no concrete repeated behavior.
- One-off project milestones (e.g. "finished Week 3 slides") unless they reveal a reusable step pattern.
- What the user said they might do next — only what they actually do or have done more than once.
- Generic preferences and identity unless they directly constrain how recurring work runs.

For each recurring domain, go one level deeper than the visible output:
- Course/slide work → how many weeks/modules, course structure, topic research per module, slide template/style.
- Newsletter → newsletter type, product/audience, how new topics are chosen, inspiration sources, pre-write research steps.
- Reports → data sources, aggregation steps, review/approval before sending.

Rules:
- Keep each item atomic, explicit, and reusable.
- Use this exact object shape: {"memory":"...","datetime":"..."}.
- Put the best available date/time for when the memory became true, happened, or was discussed.
- Use ISO 8601 datetime when possible. If only a date is known, use YYYY-MM-DD. If unknown, use null.
- Include enough detail to be actionable; skip filler/chit-chat.
- Include both upstream-preparation memories and final-output memories when both are evident.
- Output valid JSON only.

Example output:
[
  {"memory":"Before building course slides, I check how many weeks/modules exist and map the course structure first.","datetime":"2026-05-20"},
  {"memory":"For each course module I research topics and gather references before drafting slides.","datetime":"2026-05-20"},
  {"memory":"My newsletter is a product-update format for SaaS founders; I pick topics from user feedback and competitor newsletters.","datetime":"2026-05-18"},
  {"memory":"Every Monday I pull metrics from Stripe and PostHog, summarize trends, and draft a short internal update.","datetime":"2026-05-20"},
  {"memory":"Use concise, direct explanations.","datetime":null}
]`;

const PAGE_SIZE = 20;

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "your", "have", "what", "when", "where", "which", "into",
  "would", "could", "should", "about", "were", "been", "they", "them", "there", "their", "while", "also", "than",
  "then", "just", "like", "some", "more", "most", "only", "very", "over", "under", "after", "before", "because",
  "using", "used", "need", "want", "make", "made", "will", "shall", "such", "each", "every", "other", "across",
]);

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePlatform(raw: unknown): Platform {
  if (typeof raw !== "string") return "other";
  const value = raw.trim().toLowerCase();
  if (!value) return "other";
  if (value.includes("claude")) return "claude";
  if (value.includes("chatgpt") || value.includes("gpt")) return "chatgpt";
  if (value.includes("gemini")) return "gemini";
  return "other";
}

function normalizeMemoryType(raw: unknown): MemoryType {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  if (value === "preference") return "preference";
  if (value === "fact") return "fact";
  if (value === "event") return "event";
  if (value === "decision") return "decision";
  if (value === "note") return "note";
  if (value === "lesson") return "lesson";
  if (value === "failure") return "failure";
  if (value === "checkpoint") return "checkpoint";
  if (value === "collab") return "collab";
  return "unknown";
}

function inferCategory(memory: MemoryItem): string {
  const source = `${memory.text} ${JSON.stringify(memory.metadata || {})}`.toLowerCase();
  if (source.includes("project") || source.includes("task") || source.includes("deadline")) return "work";
  if (source.includes("product") || source.includes("feature") || source.includes("roadmap")) return "product";
  if (source.includes("preference") || source.includes("likes") || source.includes("style")) return "profile";
  if (source.includes("api") || source.includes("token") || source.includes("auth")) return "technical";
  return "general";
}

function normalizeCategory(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const normalized = raw.trim().toLowerCase();
  return normalized;
}

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

  const count = new Map<string, number>();
  for (const word of words) {
    count.set(word, (count.get(word) || 0) + 1);
  }

  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

function importanceScore(memory: MemoryItem): number {
  const text = memory.text || "";
  const recencyDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  const recency = Math.max(0, 1 - recencyDays / 30);
  const lengthFactor = Math.min(1, text.length / 350);
  const signalFactor = Math.min(1, (extractKeywords(text).length + (memory.metadata?.platform ? 1 : 0)) / 6);
  return Math.round((recency * 0.4 + lengthFactor * 0.3 + signalFactor * 0.3) * 100);
}

function relativeDate(iso: string): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function normalizePreferenceKey(value: string): string | null {
  const match = value.match(/^([a-z0-9 _-]{2,40})\s*:\s*.+$/i);
  if (!match) return null;
  return match[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || null;
}

function parsePastedImportItems(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const dedupe = (items: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
      const cleaned = raw.replace(/^["']|["']$/g, "").trim();
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
    }
    return out;
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const values = parsed
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            const value = rec.preference ?? rec.value ?? rec.text ?? rec.content ?? rec.memory ?? rec.fact ?? rec.note ?? rec.summary;
            if (typeof value === "string") return value;
          }
          return "";
        })
        .filter(Boolean);
      return dedupe(values);
    }

    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const prefs = obj.preferences;
      if (Array.isArray(prefs)) {
        const values = prefs
          .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
              const rec = item as Record<string, unknown>;
              const value = rec.preference ?? rec.value ?? rec.text ?? rec.content ?? rec.memory ?? rec.fact ?? rec.note ?? rec.summary;
              if (typeof value === "string") return value;
            }
            return "";
          })
          .filter(Boolean);
        return dedupe(values);
      }

      const values = Object.entries(obj)
        .map(([k, v]) => {
          if (typeof v === "string") return `${k}: ${v}`;
          return "";
        })
        .filter(Boolean);

      if (values.length > 0) return dedupe(values);
    }
  } catch {
    // Fall through to line parsing.
  }

  const lineValues = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length > 0);

  return dedupe(lineValues);
}

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));
}

const messageClass: Record<MessageKind, string> = {
  success: styles.messageSuccess,
  error: styles.messageError,
  info: styles.messageInfo,
};

function formatMemoryText(value: string): string {
  return value.replace(/^\[.*?\]\s*/, "").trim();
}

const PLATFORM_COLORS: Record<Platform, string> = {
  claude: "#D97757",
  chatgpt: "#10a37f",
  gemini: "#8E75B2",
  other: "#6b7280",
};

const PLATFORM_LABELS: Record<Platform, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  other: "Other",
};

const PLATFORM_ICONS: Record<Platform, string> = {
  claude: "/claude.svg",
  chatgpt: "/chatgpt.svg",
  gemini: "/gemini.svg",
  other: "",
};

const MEMORIES_EMPTY_IMAGE = "/memory-i.png";

function MemoryCard({ memory, isExpanded, onToggle, onDelete, isDeleting }: {
  memory: UIMemory;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const cleanText = formatMemoryText(memory.text);
  const truncLen = 120;
  const isLong = cleanText.length > truncLen;
  const previewText = isLong ? cleanText.slice(0, truncLen) + "..." : cleanText;
  const platformColor = PLATFORM_COLORS[memory.platform];

  return (
    <div className={`${styles.memoryCard} ${isExpanded ? styles.memoryCardExpanded : ""}`}>
      <button className={styles.memoryCardHeader} onClick={onToggle} aria-expanded={isExpanded}>
        <div className={styles.memoryCardLeft}>
          <span className={styles.platformBadge} style={{ background: platformColor }}>
            {PLATFORM_ICONS[memory.platform] && (
              <Image src={PLATFORM_ICONS[memory.platform]} alt="" width={14} height={14} className={styles.platformIcon} />
            )}
            {PLATFORM_LABELS[memory.platform]}
          </span>
          <span className={styles.memoryPreviewText}>{isExpanded ? cleanText : previewText}</span>
        </div>
        <div className={styles.memoryCardRight}>
          <span className={styles.memoryDate}>
            <Clock size={13} />
            {relativeDate(memory.createdAt)}
          </span>
          <span className={styles.categoryBadge}>{titleCase(memory.category)}</span>
          <ChevronDown size={16} className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} />
        </div>
      </button>

      {isExpanded && (
        <div className={styles.memoryCardBody}>
          <div className={styles.memoryFullText}>{cleanText}</div>
          <div className={styles.memoryMeta}>
            {memory.keywords.length > 0 && (
              <div className={styles.keywordsRow}>
                {memory.keywords.map((kw) => (
                  <span key={kw} className={styles.keywordTag}>
                    <Tag size={10} />
                    {kw}
                  </span>
                ))}
              </div>
            )}
            <div className={styles.memoryMetaRow}>
              <span className={styles.metaLabel}>Type</span>
              <span className={styles.metaValue}>{titleCase(memory.memoryType)}</span>
              <span className={styles.metaLabel}>Importance</span>
              <span className={styles.metaValue}>{memory.importance}</span>
              <span className={styles.metaLabel}>Created</span>
              <span className={styles.metaValue}>{new Date(memory.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div className={styles.memoryCardActions}>
            <button
              className={styles.deleteBtn}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={isDeleting}
              title="Remove memory"
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DashboardMemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationState>({
    limit: PAGE_SIZE,
    offset: 0,
    total: 0,
    hasMore: false,
  });

  const timeFilter: TimeFilter = "all";
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [isImportOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [quickPreference, setQuickPreference] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy prompt");
  const [importBusy, setImportBusy] = useState(false);
  const [persistBusy, setPersistBusy] = useState(false);
  const [importUploadProgress, setImportUploadProgress] = useState<number | null>(null);
  const [modalMessage, setModalMessage] = useState<ModalMessage | null>(null);
  const [importReport, setImportReport] = useState<ChatGptImportResult | null>(null);
  const [importJob, setImportJob] = useState<ChatGptImportJobState | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchMemories = useCallback(async (params?: {
    mode?: "initial" | "refresh";
    offset?: number;
  }) => {
    const mode = params?.mode ?? "refresh";
    const offset = Math.max(0, params?.offset ?? 0);
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const response = await fetch(`/api/memories?${query.toString()}`);
      const data = (await response.json()) as MemoriesResponsePayload;

      if (!response.ok) {
        const message = typeof data?.error === "string" ? data.error : "Failed to load memories.";
        throw new Error(message);
      }

      const memoriesPayload = Array.isArray(data?.memories) ? data.memories : [];
      const paginationPayload = data?.pagination;
      const parsedLimit = typeof paginationPayload?.limit === "number" && paginationPayload.limit > 0
        ? paginationPayload.limit
        : PAGE_SIZE;
      const parsedOffset = typeof paginationPayload?.offset === "number" && paginationPayload.offset >= 0
        ? paginationPayload.offset
        : offset;
      const parsedTotal = typeof paginationPayload?.total === "number" && paginationPayload.total >= 0
        ? paginationPayload.total
        : parsedOffset + memoriesPayload.length;
      const parsedHasMore = typeof paginationPayload?.hasMore === "boolean"
        ? paginationPayload.hasMore
        : memoriesPayload.length === parsedLimit;

      setMemories(memoriesPayload);
      setExpandedIds(new Set());
      setPagination({
        limit: parsedLimit,
        offset: parsedOffset,
        total: parsedTotal,
        hasMore: parsedHasMore,
      });
      setError(null);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "Failed to load memories.";
      setError(message);
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchMemories({ mode: "initial", offset: 0 });
  }, [fetchMemories]);

  useEffect(() => {
    if (!isImportOpen) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";

    const focusables = getFocusable(modalRef.current);
    focusables[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setImportOpen(false);
        return;
      }

      if (event.key !== "Tab") return;

      const items = getFocusable(modalRef.current);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const insideModal = active ? modalRef.current?.contains(active) : false;

      if (event.shiftKey) {
        if (!insideModal || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!insideModal || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previousFocus?.focus();
    };
  }, [isImportOpen]);

  const enriched = useMemo<UIMemory[]>(() => {
    return memories
      .map((memory) => {
        const platform = normalizePlatform(memory.metadata?.platform);
        const memoryType = normalizeMemoryType(memory.metadata?.memory_type);
        const directCategory = normalizeCategory(memory.metadata?.category);
        const category = directCategory || inferCategory(memory);

        return {
          ...memory,
          platform,
          memoryType,
          category,
          keywords: extractKeywords(memory.text || ""),
          importance: importanceScore(memory),
        };
      })
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [memories]);

  const filteredByTime = useMemo(() => {
    if (timeFilter === "all") return enriched;

    const now = Date.now();
    const msPerDay = 1000 * 60 * 60 * 24;

    let days = 0;
    switch (timeFilter) {
      case "1d":
        days = 1;
        break;
      case "7d":
        days = 7;
        break;
      case "30d":
        days = 30;
        break;
    }

    const cutoff = now - days * msPerDay;
    return enriched.filter((memory) => new Date(memory.createdAt).getTime() >= cutoff);
  }, [enriched, timeFilter]);

  const parsedImportItems = useMemo(() => parsePastedImportItems(importText), [importText]);
  const hasExportFiles = importFiles.length > 0;
  const conversationFileCount = useMemo(
    () => importFiles.filter(isConversationStreamFile).length,
    [importFiles]
  );
  const hasPasteInput = importText.trim().length > 0;
  const hasImportInput = hasPasteInput || hasExportFiles;
  const selectedImportFileNames = useMemo(() => {
    if (importFiles.length === 0) return "";
    if (importFiles.length <= 4) {
      return importFiles.map((file) => conversationJsonImportBasename(file)).join(", ");
    }
    const head = importFiles.slice(0, 3).map((file) => conversationJsonImportBasename(file)).join(", ");
    return `${head}, +${importFiles.length - 3} more`;
  }, [importFiles]);

  const savePreference = useCallback(async (content: string, platform: Platform | "other", category: string) => {
    const preferenceKey = normalizePreferenceKey(content);
    const response = await fetch("/api/memories/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        platform,
        category,
        ...(preferenceKey ? { preference_key: preferenceKey } : {}),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : "Failed to save preference.";
      throw new Error(message);
    }
  }, []);

  const enqueueImportRequest = useCallback(async (apply: boolean) => {
    const pasted = importText.trim();
    const bulkFiles = importFiles.filter(isBulkUploadFile);

    if (!pasted && bulkFiles.length === 0) {
      throw new Error("Paste ChatGPT memory JSON or select conversation JSON files from your export.");
    }

    if (bulkFiles.length > MAX_CONVERSATION_JSON_FILES) {
      throw new Error(`Select at most ${MAX_CONVERSATION_JSON_FILES} conversation JSON files.`);
    }

    if (bulkFiles.length > 0) {
      const body = new FormData();
      if (pasted) body.append("input", pasted);
      body.append("apply", String(apply));
      for (const file of bulkFiles) body.append("files", file, file.name);

      setImportUploadProgress(0);
      const payload = await new Promise<{ ref?: string; status?: ChatGptImportJobStatus; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/memories/import/chatgpt");
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setImportUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          setImportUploadProgress(null);
          let payload: { ref?: string; status?: ChatGptImportJobStatus; error?: string };
          try {
            payload = JSON.parse(xhr.responseText) as { ref?: string; status?: ChatGptImportJobStatus; error?: string };
          } catch {
            reject(new Error("Invalid import queue response."));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(typeof payload.error === "string" ? payload.error : "Import request failed."));
            return;
          }
          resolve(payload);
        };
        xhr.onerror = () => {
          setImportUploadProgress(null);
          reject(new Error("Upload failed."));
        };
        xhr.onabort = () => {
          setImportUploadProgress(null);
          reject(new Error("Upload aborted."));
        };
        xhr.send(body);
      });

      if (typeof payload.error === "string") {
        throw new Error(payload.error);
      }
      if (typeof payload.ref !== "string" || (payload.status !== "pending" && payload.status !== "processing")) {
        throw new Error("Invalid import queue response.");
      }
      return payload as { ref: string; status: ChatGptImportJobStatus };
    }

    const response = await fetch("/api/memories/import/chatgpt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: pasted, apply }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ref?: string;
      status?: ChatGptImportJobStatus;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Import request failed.");
    }
    if (typeof payload.ref !== "string" || (payload.status !== "pending" && payload.status !== "processing")) {
      throw new Error("Invalid import queue response.");
    }
    return payload as { ref: string; status: ChatGptImportJobStatus };
  }, [importFiles, importText]);

  const pollImportJob = useCallback(async (ref: string): Promise<ChatGptImportResult> => {
    const startedAt = Date.now();
    const timeoutMs = 15 * 60_000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    while (Date.now() - startedAt < timeoutMs) {
      const response = await fetch(`/api/memories/import/chatgpt/${encodeURIComponent(ref)}`, {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as ChatGptImportJobState & { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to poll import status.");
      }

      setImportJob(payload);

      if (payload.status === "done") {
        if (!payload.result) {
          throw new Error("Import completed without a result payload.");
        }
        return payload.result;
      }
      if (payload.status === "failed") {
        throw new Error(payload.error?.message || payload.progress?.message || "Import failed.");
      }

      await sleep(1200);
    }

    throw new Error("Import timed out while waiting for completion.");
  }, []);

  const runImportRequest = useCallback(async (apply: boolean): Promise<ChatGptImportResult> => {
    const queued = await enqueueImportRequest(apply);
    setImportJob({
      ref: queued.ref,
      status: queued.status,
      attempt_count: 0,
      max_attempts: 0,
      next_attempt_at: null,
      last_attempt_at: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      progress: { stage: "queued" },
      result: null,
      error: null,
    });
    return pollImportJob(queued.ref);
  }, [enqueueImportRequest, pollImportJob]);

  const handlePreviewImport = useCallback(async () => {
    if (!hasImportInput) {
      setModalMessage({ kind: "error", text: "Paste ChatGPT memory JSON or select conversation JSON files from your export." });
      return;
    }
    setImportBusy(true);
    setModalMessage(null);
    try {
      const report = await runImportRequest(false);
      setImportReport(report);
      const { accepted, selected, parsed, conflicts, duplicates, invalid } = report.summary;
      setModalMessage({
        kind: "info",
        text: `Preview ready: ${accepted} accepted from ${selected}/${parsed} selected rows, ${conflicts} conflicts, ${duplicates} duplicates, ${invalid} invalid. Click Persist memories to save.`,
      });
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Preview failed.";
      setModalMessage({ kind: "error", text: message });
    } finally {
      setImportBusy(false);
    }
  }, [hasImportInput, runImportRequest]);

  const handlePersistImport = useCallback(async () => {
    const ref = importJob?.ref;
    if (!ref || importJob?.status !== "done") {
      setModalMessage({ kind: "error", text: "Run Import first and wait for the preview to finish." });
      return;
    }
    if ((importReport?.summary.accepted ?? 0) <= 0) {
      setModalMessage({ kind: "error", text: "No accepted preview items to persist." });
      return;
    }

    setPersistBusy(true);
    setModalMessage(null);
    try {
      const response = await fetch(`/api/memories/import/chatgpt/${encodeURIComponent(ref)}/persist`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        persisted?: number;
        duplicates?: number;
        conflicts?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Persist failed.");
      }

      const persisted = payload.persisted ?? 0;
      setImportReport((current) => {
        if (!current) return current;
        return {
          ...current,
          summary: {
            ...current.summary,
            persisted,
            embedded: persisted,
          },
          preview: [],
        };
      });
      await fetchMemories({ mode: "refresh", offset: 0 });
      setModalMessage({
        kind: "success",
        text: `Persisted ${persisted} memor${persisted === 1 ? "y" : "ies"}. Conflicts were quarantined for review.`,
      });
    } catch (persistError) {
      const message = persistError instanceof Error ? persistError.message : "Persist failed.";
      setModalMessage({ kind: "error", text: message });
    } finally {
      setPersistBusy(false);
    }
  }, [fetchMemories, importJob?.ref, importJob?.status, importReport?.summary.accepted]);

  const handleImportFileSelection = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    const accepted = picked.filter(isConversationJsonImportFile);
    const rejected = picked.filter((file) => !isConversationJsonImportFile(file));
    const capped = accepted.slice(0, MAX_CONVERSATION_JSON_FILES);
    setImportFiles(capped);
    setImportReport(null);
    setImportJob(null);

    if (accepted.length === 0) {
      const sampleNames = rejected.slice(0, 3).map(conversationJsonImportBasename).join(", ");
      setModalMessage({
        kind: "error",
        text: rejected.length > 0
          ? `No conversation JSON files found${sampleNames ? ` (got ${sampleNames})` : ""}. Select conversations.json or conversations-NNN.json files from your export.`
          : "Select conversation JSON files from your extracted ChatGPT export.",
      });
      return;
    }

    if (accepted.length > MAX_CONVERSATION_JSON_FILES) {
      setModalMessage({
        kind: "error",
        text: `Select at most ${MAX_CONVERSATION_JSON_FILES} conversation JSON files.`,
      });
      return;
    }

    if (rejected.length > 0) {
      const skippedNames = rejected.slice(0, 3).map(conversationJsonImportBasename).join(", ");
      const suffix = rejected.length > 3 ? ` and ${rejected.length - 3} more` : "";
      setModalMessage({
        kind: "info",
        text: `Selected ${capped.length} conversation file${capped.length === 1 ? "" : "s"}; skipped ${rejected.length} other export file${rejected.length === 1 ? "" : "s"} (${skippedNames}${suffix}).`,
      });
      return;
    }

    setModalMessage(null);
  }, []);

  const handleQuickAdd = useCallback(async () => {
    const content = quickPreference.trim();
    if (!content) return;

    setImportBusy(true);
    setModalMessage(null);

    try {
      await savePreference(content, "other", "manual");
      setQuickPreference("");
      await fetchMemories({ mode: "refresh", offset: 0 });
      setModalMessage({ kind: "success", text: "Preference saved." });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Failed to save preference.";
      setModalMessage({ kind: "error", text: message });
    } finally {
      setImportBusy(false);
    }
  }, [fetchMemories, quickPreference, savePreference]);

  const handleCopyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CHATGPT_MEMORY_EXPORT_PROMPT);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy prompt"), 1500);
    } catch {
      setCopyLabel("Copy failed");
      setTimeout(() => setCopyLabel("Copy prompt"), 1800);
    }
  }, []);

  const openImportModal = useCallback(() => {
    setImportOpen(true);
    setModalMessage(null);
    setImportReport(null);
    setImportJob(null);
  }, []);

  const handleDeleteMemory = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!response.ok) return;
      const backOnePage = memories.length === 1 && pagination.offset > 0;
      const nextOffset = backOnePage
        ? Math.max(0, pagination.offset - pagination.limit)
        : pagination.offset;
      await fetchMemories({ mode: "refresh", offset: nextOffset });
    } finally {
      setDeletingId(null);
    }
  }, [fetchMemories, memories.length, pagination.limit, pagination.offset]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(() => {
    void fetchMemories({ mode: "refresh", offset: pagination.offset });
  }, [fetchMemories, pagination.offset]);

  const handleNextPage = useCallback(() => {
    if (!pagination.hasMore) return;
    void fetchMemories({ mode: "refresh", offset: pagination.offset + pagination.limit });
  }, [fetchMemories, pagination.hasMore, pagination.limit, pagination.offset]);

  const handlePrevPage = useCallback(() => {
    if (pagination.offset <= 0) return;
    void fetchMemories({ mode: "refresh", offset: Math.max(0, pagination.offset - pagination.limit) });
  }, [fetchMemories, pagination.limit, pagination.offset]);

  const rangeStart = filteredByTime.length > 0 ? pagination.offset + 1 : 0;
  const rangeEnd = pagination.offset + filteredByTime.length;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Memories</h1>
        <div className={styles.actionButtons}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={openImportModal}
            disabled={loading}
          >
            Import from ChatGPT
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleRefresh}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} className={refreshing ? styles.spin : ""} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      <div className={styles.listMeta}>
        {pagination.total > 0
          ? `Showing ${rangeStart}-${rangeEnd} of ${pagination.total} memories`
          : "No memories yet"}
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      <div className={styles.cardList}>
        {loading ? (
          <>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={styles.skeletonCard}>
                <div className={styles.skeletonCardHeader}>
                  <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
                  <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
                </div>
                <div className={styles.skeletonCardMeta}>
                  <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
                  <div className={`${styles.skeleton} ${styles.skeletonTag}`} />
                </div>
              </div>
            ))}
          </>
        ) : filteredByTime.length === 0 ? (
          <EmptyCollectionState
            title="No memories found"
            description={
              timeFilter !== "all"
                ? "Try a different time range."
                : "Connect Tallei to your AI assistants to automatically capture and organize your preferences, facts, and important information."
            }
            actionLabel={timeFilter === "all" ? "" : undefined}
            actionHref={timeFilter === "all" ? "/dashboard/setup" : undefined}
            imageSrc={MEMORIES_EMPTY_IMAGE || undefined}
            illustration="none"
          />
        ) : (
          filteredByTime.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              isExpanded={expandedIds.has(memory.id)}
              onToggle={() => toggleExpand(memory.id)}
              onDelete={() => void handleDeleteMemory(memory.id)}
              isDeleting={deletingId === memory.id}
            />
          ))
        )}
      </div>

      {!loading && filteredByTime.length > 0 && (
        <div className={styles.paginationBar}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handlePrevPage}
            disabled={refreshing || pagination.offset <= 0}
          >
            Previous
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleNextPage}
            disabled={refreshing || !pagination.hasMore}
          >
            Next
          </button>
        </div>
      )}

      {isImportOpen && (
        <div
          className={styles.modalBackdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setImportOpen(false);
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" ref={modalRef}>
            <div className={styles.modalHeader}>
              <h2 id="import-dialog-title" className={styles.modalTitle}>
                {hasExportFiles ? "Import ChatGPT Export" : "Import ChatGPT Memories"}
              </h2>
              <Button variant="ghost" size="icon" className={styles.modalClose}
                onClick={() => setImportOpen(false)}
                aria-label="Close dialog"
              >
                <X size={16} />
              </Button>
            </div>

            <p className={styles.modalSubtitle}>
              {hasExportFiles
                ? `${conversationFileCount} conversation file${conversationFileCount === 1 ? "" : "s"} ready. Click Import to preview, then Persist memories to save. Profile files like user.json are handled separately.`
                : "Export from ChatGPT, unzip locally, and select all files in the folder (Cmd/Ctrl+A). Or paste a memory JSON dump below."}
            </p>

            {modalMessage && (
              <div className={`${styles.modalMessage} ${messageClass[modalMessage.kind]}`}>
                {modalMessage.text}
              </div>
            )}

            <section className={styles.importSection}>
              <h3 className={styles.importSectionTitle}>Chat history export</h3>
              <div className={styles.importFileRow}>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept={BULK_IMPORT_ACCEPT}
                  multiple
                  onChange={handleImportFileSelection}
                  className={styles.importFileInput}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={importBusy || persistBusy}
                  onClick={() => importFileInputRef.current?.click()}
                >
                  Select JSON files
                </Button>
                <span className={styles.importFileHint}>
                  {hasExportFiles
                    ? `${importFiles.length} selected (${conversationFileCount} conversation${conversationFileCount === 1 ? "" : "s"}): ${selectedImportFileNames}`
                    : "Unzip your export, then Cmd/Ctrl+A in the folder — extra export JSON files are skipped automatically."}
                </span>
                {importUploadProgress !== null && (
                  <div className={styles.importUploadProgress} aria-live="polite">
                    <span>Uploading {importUploadProgress}%</span>
                    <div className={styles.importUploadProgressBar}>
                      <div className={styles.importUploadProgressFill} style={{ width: `${importUploadProgress}%` }} />
                    </div>
                  </div>
                )}
                {hasExportFiles && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={importBusy || persistBusy}
                    onClick={() => {
                      setImportFiles([]);
                      setImportReport(null);
                      setImportJob(null);
                      setModalMessage(null);
                      if (importFileInputRef.current) importFileInputRef.current.value = "";
                    }}
                  >
                    Clear files
                  </Button>
                )}
              </div>
            </section>

            {!hasExportFiles && (
              <details className={styles.importPasteSection} open={hasPasteInput}>
                <summary className={styles.importSectionTitle}>Memory dump JSON (optional)</summary>
                <div className={styles.modalTopActions}>
                  <Button variant="outline" size="sm" onClick={() => void handleCopyPrompt()}>
                    <Copy size={14} />
                    {copyLabel}
                  </Button>
                  <details className={styles.promptDetails}>
                    <summary>Show prompt text</summary>
                    <pre>{CHATGPT_MEMORY_EXPORT_PROMPT}</pre>
                  </details>
                </div>

                <textarea
                  value={importText}
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportReport(null);
                    setImportJob(null);
                  }}
                  className={styles.importTextarea}
                  rows={6}
                  placeholder='Paste ChatGPT output, e.g. [{"memory":"Before building course slides, I map the course structure and research topics per module.","datetime":"2026-05-20"}]'
                />
              </details>
            )}

            <div className={styles.importFooter}>
              <span className={styles.parsedHint}>
                {hasExportFiles
                  ? `${conversationFileCount} conversation file${conversationFileCount === 1 ? "" : "s"} ready to import`
                  : `Parsed ${parsedImportItems.length} pasted candidate memor${parsedImportItems.length === 1 ? "y" : "ies"}`}
              </span>
              <div className={styles.importActionsRow}>
                <Button
                  variant="outline"
                  disabled={importBusy || persistBusy || !hasImportInput}
                  onClick={() => void handlePreviewImport()}
                >
                  {importBusy ? "Importing..." : "Import"}
                </Button>
                <Button
                  disabled={
                    importBusy
                    || persistBusy
                    || importJob?.status !== "done"
                    || !importReport
                    || importReport.summary.accepted === 0
                  }
                  onClick={() => void handlePersistImport()}
                >
                  {persistBusy
                    ? "Persisting..."
                    : `Persist memories (${importReport?.summary.accepted ?? 0})`}
                </Button>
              </div>
            </div>

            {importJob && (
              <div className={styles.importJobStatus}>
                <strong>Job {importJob.ref.slice(0, 12)}</strong>
                <span>
                  status: {importJob.status}
                  {importJob.progress?.stage ? ` · ${importJob.progress.stage}` : ""}
                  {importJob.progress?.message ? ` · ${importJob.progress.message}` : ""}
                  {importJob.attempt_count > 0 && importJob.max_attempts > 0
                    ? ` · attempt ${importJob.attempt_count}/${importJob.max_attempts}`
                    : ""}
                </span>
                {importJob.status === "failed" && importJob.error?.message && (
                  <span className={styles.importJobError}>{importJob.error.message}</span>
                )}
              </div>
            )}

            {importReport && (
              <div className={styles.importReport}>
                <div className={styles.importReportHeader}>
                  <strong>Preview Report</strong>
                  <span>Batch {importReport.batchId.slice(0, 8)} · mode: {importReport.mode}</span>
                </div>
                <div className={styles.importSummaryGrid}>
                  <div className={styles.importSummaryCell}><span>Conversations</span><strong>{importReport.summary.parsed}</strong></div>
                  <div className={styles.importSummaryCell}><span>Hard dropped</span><strong>{importReport.summary.hardDropped}</strong></div>
                  <div className={styles.importSummaryCell}><span>KEEP_HIGH</span><strong>{importReport.summary.keepHigh}</strong></div>
                  <div className={styles.importSummaryCell}><span>KEEP_WEAK</span><strong>{importReport.summary.keepWeak}</strong></div>
                  <div className={styles.importSummaryCell}><span>DROP</span><strong>{importReport.summary.dropped}</strong></div>
                  <div className={styles.importSummaryCell}><span>Extracted</span><strong>{importReport.summary.extracted}</strong></div>
                  <div className={styles.importSummaryCell}><span>Accepted</span><strong>{importReport.summary.accepted}</strong></div>
                  <div className={styles.importSummaryCell}><span>Conflicts</span><strong>{importReport.summary.conflicts}</strong></div>
                  <div className={styles.importSummaryCell}><span>Duplicates</span><strong>{importReport.summary.duplicates}</strong></div>
                  <div className={styles.importSummaryCell}><span>Invalid</span><strong>{importReport.summary.invalid}</strong></div>
                  <div className={styles.importSummaryCell}><span>Persisted</span><strong>{importReport.summary.persisted}</strong></div>
                  <div className={styles.importSummaryCell}><span>Embedded</span><strong>{importReport.summary.embedded}</strong></div>
                </div>

                {importReport.ingestSummary && (
                  <div className={styles.ingestSummary}>
                    <strong>Ingest summary</strong>
                    <p>
                      Parsed: {importReport.ingestSummary.sourcesParsed.join(", ") || "none"}
                      {importReport.ingestSummary.skipped.binaryDat > 0
                        ? ` · Skipped ${importReport.ingestSummary.skipped.binaryDat} media/.dat file(s)`
                        : ""}
                      {typeof importReport.ingestSummary.skippedMediaFiles === "number" && importReport.ingestSummary.skippedMediaFiles > 0
                        ? ` · Skipped ${importReport.ingestSummary.skippedMediaFiles} image/audio/video file(s)`
                        : ""}
                      {typeof importReport.ingestSummary.skippedOldConversations === "number" && importReport.ingestSummary.skippedOldConversations > 0
                        ? ` · Skipped ${importReport.ingestSummary.skippedOldConversations} conversation(s) older than 12 months`
                        : ""}
                      {importReport.ingestSummary.skipped.libraryCatalog > 0
                        ? ` · Skipped ${importReport.ingestSummary.skipped.libraryCatalog} library catalog file(s)`
                        : ""}
                    </p>
                    {importReport.ingestSummary.dat && (
                      <p>
                        .dat inspected: {importReport.ingestSummary.dat.inspected}
                        {` · extracted ${importReport.ingestSummary.dat.extracted}`}
                        {` · metadata-only ${importReport.ingestSummary.dat.metadataOnly}`}
                        {` · skipped ${importReport.ingestSummary.dat.skipped}`}
                      </p>
                    )}
                    {!importReport.ingestSummary.hasConversationsJson && (
                      <p className={styles.ingestWarning}>
                        No conversations.json in archive — only partial data imported. Re-export from ChatGPT Settings → Data Controls for full history.
                      </p>
                    )}
                  </div>
                )}

                {importReport.warnings.length > 0 && (
                  <div className={styles.importSection}>
                    <h3>Warnings</h3>
                    <ul className={styles.importList}>
                      {importReport.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {importReport.conflicts.length > 0 && (
                  <div className={styles.importSection}>
                    <h3>Conflicts (quarantined)</h3>
                    <div className={styles.importList}>
                      {importReport.conflicts.slice(0, 8).map((conflict, index) => (
                          <div key={`${conflict.existing.memoryId}-${index}`} className={styles.importListItem}>
                            <div><strong>Candidate:</strong> {conflict.candidate.raw}</div>
                            {conflict.candidate.sourceDateTime && (
                              <div><strong>Source date:</strong> {conflict.candidate.sourceDateTime}</div>
                            )}
                            <div><strong>Existing:</strong> {conflict.existing.text}</div>
                          </div>
                      ))}
                    </div>
                  </div>
                )}

                {importReport.preview.length > 0 && (
                  <div className={styles.importSection}>
                    <h3>Extracted memories</h3>
                    <div className={styles.importList}>
                      {importReport.preview
                        .filter((candidate) => candidate.status === "accepted")
                        .slice(0, 12)
                        .map((candidate, index) => (
                          <div key={`${candidate.normalized}-${index}`} className={styles.importListItem}>
                            <span>{candidate.raw.length > 240 ? `${candidate.raw.slice(0, 240)}…` : candidate.raw}</span>
                            <em>
                              {candidate.extractType ?? candidate.memoryType}
                              {candidate.category ? ` · ${candidate.category}` : ""}
                              {typeof candidate.extractConfidence === "number"
                                ? ` · confidence ${Math.round(candidate.extractConfidence * 100)}%`
                                : ""}
                              {candidate.sourceDateTime ? ` · ${candidate.sourceDateTime}` : ""}
                            </em>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {importReport.duplicates.length > 0 && (
                  <div className={styles.importSection}>
                    <h3>Duplicates skipped</h3>
                    <div className={styles.importList}>
                      {importReport.duplicates.slice(0, 8).map((duplicate, index) => (
                        <div key={`${duplicate.candidate.normalized}-${index}`} className={styles.importListItem}>
                          <span>{duplicate.candidate.raw}</span>
                          <em>{duplicate.reason}</em>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {importReport.warnings.length > 0 && (
                  <div className={styles.importSection}>
                    <h3>Warnings</h3>
                    <ul className={styles.importWarnings}>
                      {importReport.warnings.slice(0, 8).map((warning, index) => (
                        <li key={`${warning}-${index}`}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className={styles.quickAddBlock}>
              <label className={styles.quickAddLabel} htmlFor="quick-preference-input">Add single preference</label>
              <div className={styles.quickAddRow}>
                <input
                  id="quick-preference-input"
                  value={quickPreference}
                  onChange={(event) => setQuickPreference(event.target.value)}
                  placeholder="Example: Keep responses concise and direct."
                  className={styles.quickAddInput}
                />
                <Button
                  variant="outline"
                  disabled={importBusy || quickPreference.trim().length === 0}
                  onClick={() => void handleQuickAdd()}
                >
                  Add preference
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

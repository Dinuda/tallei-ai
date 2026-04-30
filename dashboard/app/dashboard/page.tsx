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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { EmptyCollectionState } from "./components/empty-collection-state";
import styles from "./page.module.css";

type MemoryItem = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type Platform = "claude" | "chatgpt" | "gemini" | "other";
type MemoryType = "preference" | "fact" | "event" | "decision" | "note" | "unknown";

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

const CHATGPT_PREFERENCE_EXPORT_PROMPT = `Extract my stable preferences from this chat and return ONLY a JSON array of strings.\n\nRules:\n- Include writing style, tone, formatting rules, language preferences, tooling habits, and recurring constraints.\n- Keep each item short, explicit, and actionable.\n- Skip temporary requests or one-off tasks.\n- Output valid JSON only.\n\nExample output:\n[\n  "Use concise, direct explanations.",\n  "Prefer TypeScript over JavaScript when both are possible.",\n  "Show final answers with short bullet lists."\n]`;

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

function parsePastedPreferences(input: string): string[] {
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
            const value = rec.preference ?? rec.value ?? rec.text ?? rec.content;
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
              const value = rec.preference ?? rec.value ?? rec.text ?? rec.content;
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
  const [quickPreference, setQuickPreference] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy prompt");
  const [importBusy, setImportBusy] = useState(false);
  const [modalMessage, setModalMessage] = useState<ModalMessage | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

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

  const parsedImportItems = useMemo(() => parsePastedPreferences(importText), [importText]);

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

  const handleImport = useCallback(async () => {
    const items = parsePastedPreferences(importText);
    if (items.length === 0) {
      setModalMessage({ kind: "error", text: "No preference lines found. Paste JSON or one line per preference." });
      return;
    }

    setImportBusy(true);
    setModalMessage(null);

    let success = 0;
    let failed = 0;

    for (const item of items) {
      try {
        await savePreference(item, "chatgpt", "chatgpt-import");
        success += 1;
      } catch {
        failed += 1;
      }
    }

    await fetchMemories({ mode: "refresh", offset: 0 });
    setImportBusy(false);

    if (failed === 0) {
      setImportText("");
      setModalMessage({
        kind: "success",
        text: `Imported ${success} preference${success === 1 ? "" : "s"} from ChatGPT.`,
      });
      return;
    }

    setModalMessage({
      kind: "error",
      text: `Imported ${success} preference${success === 1 ? "" : "s"}. ${failed} failed.`,
    });
  }, [fetchMemories, importText, savePreference]);

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
      await navigator.clipboard.writeText(CHATGPT_PREFERENCE_EXPORT_PROMPT);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy prompt"), 1500);
    } catch {
      setCopyLabel("Copy failed");
      setTimeout(() => setCopyLabel("Copy prompt"), 1800);
    }
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
              <h2 id="import-dialog-title" className={styles.modalTitle}>Import Preferences From ChatGPT</h2>
              <Button variant="ghost" size="icon" className={styles.modalClose}
                onClick={() => setImportOpen(false)}
                aria-label="Close dialog"
              >
                <X size={16} />
              </Button>
            </div>

            <p className={styles.modalSubtitle}>
              Copy the prompt into ChatGPT, then paste the response here as JSON or one preference per line.
            </p>

            {modalMessage && (
              <div className={`${styles.modalMessage} ${messageClass[modalMessage.kind]}`}>
                {modalMessage.text}
              </div>
            )}

            <div className={styles.modalTopActions}>
              <Button variant="outline" size="sm" onClick={() => void handleCopyPrompt()}>
                <Copy size={14} />
                {copyLabel}
              </Button>
              <details className={styles.promptDetails}>
                <summary>Show prompt text</summary>
                <pre>{CHATGPT_PREFERENCE_EXPORT_PROMPT}</pre>
              </details>
            </div>

            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              className={styles.importTextarea}
              rows={8}
              placeholder='Paste ChatGPT output (JSON array, object, or one line per preference)'
            />

            <div className={styles.importFooter}>
              <span className={styles.parsedHint}>
                Parsed {parsedImportItems.length} preference{parsedImportItems.length === 1 ? "" : "s"}
              </span>
              <Button
                disabled={importBusy || parsedImportItems.length === 0}
                onClick={() => void handleImport()}
              >
                {importBusy ? "Importing..." : "Import preferences"}
              </Button>
            </div>

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

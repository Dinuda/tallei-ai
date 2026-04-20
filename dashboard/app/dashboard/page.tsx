"use client";

import {
  Copy,
  FilterX,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
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

type MessageKind = "success" | "error" | "info";

type ModalMessage = {
  kind: MessageKind;
  text: string;
};

const CHATGPT_PREFERENCE_EXPORT_PROMPT = `Extract my stable preferences from this chat and return ONLY a JSON array of strings.\n\nRules:\n- Include writing style, tone, formatting rules, language preferences, tooling habits, and recurring constraints.\n- Keep each item short, explicit, and actionable.\n- Skip temporary requests or one-off tasks.\n- Output valid JSON only.\n\nExample output:\n[\n  "Use concise, direct explanations.",\n  "Prefer TypeScript over JavaScript when both are possible.",\n  "Show final answers with short bullet lists."\n]`;

const TYPE_BUCKETS: MemoryType[] = ["preference", "fact", "event", "decision", "note", "unknown"];
const PLATFORM_BUCKETS: Platform[] = ["claude", "chatgpt", "gemini", "other"];

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
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

export default function DashboardMemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selectedType, setSelectedType] = useState<MemoryType | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [isImportOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [quickPreference, setQuickPreference] = useState("");
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const [copyLabel, setCopyLabel] = useState("Copy prompt");
  const [importBusy, setImportBusy] = useState(false);
  const [modalMessage, setModalMessage] = useState<ModalMessage | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const fetchMemories = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      const response = await fetch("/api/memories");
      const data = await response.json();

      if (!response.ok) {
        const message = typeof data?.error === "string" ? data.error : "Failed to load memories.";
        throw new Error(message);
      }

      setMemories(Array.isArray(data?.memories) ? data.memories : []);
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
    void fetchMemories("initial");
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

  const parsedImportItems = useMemo(() => parsePastedPreferences(importText), [importText]);

  const typeCounts = useMemo(() => {
    const map = new Map<MemoryType, number>();
    TYPE_BUCKETS.forEach((type) => map.set(type, 0));
    enriched.forEach((memory) => {
      map.set(memory.memoryType, (map.get(memory.memoryType) || 0) + 1);
    });
    return map;
  }, [enriched]);

  const platformCounts = useMemo(() => {
    const map = new Map<Platform, number>();
    PLATFORM_BUCKETS.forEach((platform) => map.set(platform, 0));
    enriched.forEach((memory) => {
      map.set(memory.platform, (map.get(memory.platform) || 0) + 1);
    });
    return map;
  }, [enriched]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    enriched.forEach((memory) => {
      map.set(memory.category, (map.get(memory.category) || 0) + 1);
    });

    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 14);
  }, [enriched]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return enriched.filter((memory) => {
      if (selectedType && memory.memoryType !== selectedType) return false;
      if (selectedPlatform && memory.platform !== selectedPlatform) return false;
      if (selectedCategory && memory.category !== selectedCategory) return false;

      if (!normalizedQuery) return true;

      const haystack = `${memory.text} ${memory.platform} ${memory.memoryType} ${memory.category} ${memory.keywords.join(" ")}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [enriched, query, selectedType, selectedPlatform, selectedCategory]);

  const hasActiveFilters = Boolean(selectedType || selectedPlatform || selectedCategory);

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

    await fetchMemories("refresh");
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
      await fetchMemories("refresh");
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
      setMemories((current) => current.filter((item) => item.id !== id));
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.toolbarRow}>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            className={styles.headerSecondaryAction}
            onClick={() => void fetchMemories("refresh")}
            disabled={loading || refreshing}
          >
            <RefreshCw size={15} className={refreshing ? styles.spin : ""} />
            Refresh
          </Button>

          <Button
            variant="secondary"
            className={styles.headerPrimaryAction}
            onClick={() => {
              setModalMessage(null);
              setImportOpen(true);
            }}
          >
            <Upload size={15} />
            Import Preferences
          </Button>
        </div>

        {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}
      </div>

      <section className={styles.filterBar}>
        <label className={styles.searchWrap}>
          <Search size={16} className={styles.searchIcon} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search text, platform, type, category..."
            className={styles.searchInput}
          />
        </label>

        <label className={styles.filterGroup}>
          <select
            className={styles.filterSelect}
            value={selectedType || ""}
            onChange={(e) => setSelectedType((e.target.value as MemoryType) || null)}
          >
            <option value="">All Types</option>
            {TYPE_BUCKETS.map((type) => (
              <option key={type} value={type}>{titleCase(type)} ({typeCounts.get(type) || 0})</option>
            ))}
          </select>
        </label>

        <label className={styles.filterGroup}>
          <select
            className={styles.filterSelect}
            value={selectedPlatform || ""}
            onChange={(e) => setSelectedPlatform((e.target.value as Platform) || null)}
          >
            <option value="">All Platforms</option>
            {PLATFORM_BUCKETS.map((platform) => (
              <option key={platform} value={platform}>{titleCase(platform)} ({platformCounts.get(platform) || 0})</option>
            ))}
          </select>
        </label>

        <label className={styles.filterGroup}>
          <select
            className={styles.filterSelect}
            value={selectedCategory || ""}
            onChange={(e) => setSelectedCategory(e.target.value || null)}
          >
            <option value="">All Categories</option>
            {categoryCounts.map(([category, count]) => (
              <option key={category} value={category}>{titleCase(category)} ({count})</option>
            ))}
          </select>
        </label>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.clearButton}
            onClick={() => {
              setSelectedType(null);
              setSelectedPlatform(null);
              setSelectedCategory(null);
            }}
          >
            <FilterX size={14} />
            Clear
          </Button>
        )}
      </section>

      <section className={styles.listPanel}>
        <div className={styles.listHeader}>
          <p className={styles.deckMeta}>
            {filtered.length} {filtered.length === 1 ? "memory" : "memories"}
          </p>
        </div>

        {loading ? (
          <div className={styles.skeletonStack}>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.emptyState}>
            <h2 className={styles.emptyTitle}>No memories match</h2>
            <p className={styles.emptyText}>
              {query || hasActiveFilters
                ? "Try a different search term or clear active filters."
                : "No memories yet. Add memories from your connected assistants or import preferences."}
            </p>
          </div>
        ) : (
          <ul className={styles.memoryList}>
            {filtered.map((memory) => {
              const isDeleting = deletingId === memory.id;
              const cleanText = formatMemoryText(memory.text);
              const canExpand = cleanText.length > 260;
              const isExpanded = Boolean(expandedById[memory.id]);
              return (
                <Card key={memory.id} variant="flat" className={styles.memoryCard}>
                  <div className={styles.memoryBody}>
                    <p className={`${styles.memoryText} ${!isExpanded ? styles.memoryTextClamped : ""}`}>
                      {cleanText}
                    </p>
                    {canExpand && (
                      <button
                        type="button"
                        className={styles.expandButton}
                        onClick={() =>
                          setExpandedById((current) => ({
                            ...current,
                            [memory.id]: !current[memory.id],
                          }))
                        }
                      >
                        {isExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>

                  <div className={styles.memoryFooter}>
                    <div className={styles.memoryMeta}>
                      <span className={styles.metaPill}>{titleCase(memory.platform)}</span>
                      <span className={styles.metaPill}>{titleCase(memory.memoryType)}</span>
                      <span className={styles.metaPill}>{titleCase(memory.category)}</span>
                      <span className={styles.metaDate}>{relativeDate(memory.createdAt)}</span>
                    </div>

                    <div className={styles.memoryActions}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={styles.deleteButton}
                        onClick={() => void handleDeleteMemory(memory.id)}
                        disabled={isDeleting}
                        title="Remove memory"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </section>

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

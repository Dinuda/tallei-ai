"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useCallback } from "react";

interface MemoryItem {
  id: string;
  text: string;
  metadata: Record<string, string>;
  createdAt: string;
}

/* ── Platform styling ──────────────────────────────────────────── */
const PLATFORM_STYLES: Record<string, { bg: string; color: string; border: string; label: string }> = {
  claude:  { bg: "rgba(251,146,60,.13)",  color: "#ffc97a", border: "rgba(251,146,60,.28)", label: "Claude" },
  chatgpt: { bg: "rgba(96,165,250,.13)",  color: "#a8d4ff", border: "rgba(96,165,250,.28)", label: "ChatGPT" },
  gemini:  { bg: "rgba(168,85,247,.13)",  color: "#d4b4ff", border: "rgba(168,85,247,.28)", label: "Gemini" },
  other:   { bg: "#12161d",               color: "#c0c8d4", border: "#2a3039",               label: "Other" },
};

function platformStyle(p: string) {
  return PLATFORM_STYLES[(p || "other").toLowerCase()] ?? PLATFORM_STYLES.other;
}

const PLATFORMS = ["all", "claude", "chatgpt", "gemini", "other"] as const;
type PlatformFilter = typeof PLATFORMS[number];

/* ── Keyword extraction ─────────────────────────────────────────── */
const STOPWORDS = new Set([
  "the","and","for","that","with","this","from","your","have","what","when",
  "where","which","into","would","could","should","about","were","been","they",
  "them","there","their","while","also","than","then","just","like","some",
  "more","most","only","very","over","under","after","before","because","using",
  "used","need","want","make","made","will","shall","such","each","every",
]);

function extractKeywords(text: string): string[] {
  const count = new Map<string, number>();
  for (const word of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) count.set(word, (count.get(word) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
}

/* ── Stats strip ────────────────────────────────────────────────── */
function StatsStrip({ memories, loading }: { memories: MemoryItem[]; loading: boolean }) {
  const stats = useMemo(() => {
    const platforms = new Set(memories.map((m) => (m.metadata?.platform || "other").toLowerCase()));
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = memories.filter((m) => new Date(m.createdAt).getTime() > weekAgo).length;
    return { total: memories.length, platforms: platforms.size, thisWeek };
  }, [memories]);

  const items = [
    { label: "Total memories", value: loading ? "—" : String(stats.total) },
    { label: "AI platforms", value: loading ? "—" : String(stats.platforms) },
    { label: "This week", value: loading ? "—" : `+${stats.thisWeek}` },
  ];

  return (
    <div style={{ display: "flex", gap: "1px", marginBottom: "1.5rem", borderRadius: "10px", overflow: "hidden", border: "1px solid #1f1f22" }}>
      {items.map((item, i) => (
        <div
          key={item.label}
          style={{
            flex: 1,
            padding: "0.75rem 1.1rem",
            background: "#0e0e0e",
            borderRight: i < items.length - 1 ? "1px solid #1f1f22" : "none",
          }}
        >
          <p style={{ fontSize: "0.72rem", color: "#52525b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.2rem" }}>
            {item.label}
          </p>
          <p style={{ fontSize: "1.2rem", fontWeight: 600, color: "#fafafa", lineHeight: 1 }}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────── */
function EmptyOnboarding() {
  return (
    <div style={{ padding: "3rem 2rem", textAlign: "center" }}>
      <div style={{
        width: "48px", height: "48px", borderRadius: "12px",
        background: "linear-gradient(145deg, #1c2a0e 0%, #111a09 100%)",
        border: "1px solid #2a3f18",
        display: "flex", alignItems: "center", justifyContent: "center",
        margin: "0 auto 1.2rem",
      }}>
        <svg width="22" height="22" viewBox="0 0 15 15" fill="none" aria-hidden>
          <path d="M7.5 1C3.9 1 1 3.9 1 7.5S3.9 14 7.5 14 14 11.1 14 7.5 11.1 1 7.5 1Z" stroke="#7daf38" strokeWidth="1.2" />
          <path d="M7.5 4.5V8M7.5 10.5V11" stroke="#7daf38" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
      <h3 style={{ fontSize: "1.1rem", fontWeight: 600, color: "#fafafa", marginBottom: "0.55rem" }}>
        No memories yet
      </h3>
      <p style={{ fontSize: "0.85rem", color: "#71717a", maxWidth: "360px", margin: "0 auto 1.8rem", lineHeight: 1.6 }}>
        Connect Claude or ChatGPT and start a conversation — Tallei will automatically capture what matters.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
        <Link
          href="/dashboard/setup"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.45rem",
            padding: "0.6rem 1.2rem",
            background: "linear-gradient(145deg, #8ec642, #7daf38)",
            color: "#17220a", fontWeight: 600, fontSize: "0.84rem",
            borderRadius: "8px", textDecoration: "none",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 15 15" fill="none" aria-hidden>
            <path d="M5.2 2V5.2M9.8 2V5.2M4.1 5.2H10.9V7.3C10.9 9.2 9.4 10.7 7.5 10.7C5.6 10.7 4.1 9.2 4.1 7.3V5.2Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M7.5 10.7V13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          Connect an AI
        </Link>
        <a
          href="https://claude.ai"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.45rem",
            padding: "0.6rem 1.2rem",
            background: "transparent", border: "1px solid #2a3039",
            color: "#a1a1aa", fontWeight: 500, fontSize: "0.84rem",
            borderRadius: "8px", textDecoration: "none",
          }}
        >
          Open Claude
          <svg width="11" height="11" viewBox="0 0 15 15" fill="none" aria-hidden>
            <path d="M5 2.5H12.5V10M12.5 2.5L2.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </a>
      </div>
    </div>
  );
}

/* ── Memory card ────────────────────────────────────────────────── */
function MemoryCard({ memory, onDelete }: { memory: MemoryItem; onDelete: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const style = platformStyle(memory.metadata?.platform);
  const keywords = useMemo(() => extractKeywords(memory.text || ""), [memory.text]);
  const isLong = memory.text.length > 220;
  const displayText = isLong && !expanded ? memory.text.slice(0, 220) + "…" : memory.text;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/memories/${memory.id}`, { method: "DELETE" });
      if (res.ok) onDelete(memory.id);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article
      style={{
        background: "#0d1117",
        border: "1px solid #1f2530",
        borderRadius: "12px",
        padding: "1rem 1.1rem",
        transition: "border-color 0.14s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#2a3242")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1f2530")}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <span style={{
            display: "inline-flex", alignItems: "center",
            padding: "0.18rem 0.55rem",
            borderRadius: "999px",
            fontSize: "0.69rem", fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.06em",
            background: style.bg, color: style.color, border: `1px solid ${style.border}`,
          }}>
            {style.label}
          </span>
          {keywords.map((k) => (
            <span key={k} style={{
              padding: "0.16rem 0.48rem",
              borderRadius: "999px",
              fontSize: "0.67rem", color: "#52525b",
              border: "1px solid #1f2530",
              background: "transparent",
            }}>
              {k}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 }}>
          <span style={{ fontSize: "0.72rem", color: "#3f4654", whiteSpace: "nowrap" }}>
            {memory.createdAt
              ? new Date(memory.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
              : "—"}
          </span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            aria-label="Delete memory"
            title="Delete"
            style={{
              width: "26px", height: "26px",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "1px solid transparent",
              borderRadius: "6px", cursor: "pointer",
              color: "#3f4654", transition: "all 0.12s",
              opacity: deleting ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,.12)";
              e.currentTarget.style.borderColor = "rgba(239,68,68,.28)";
              e.currentTarget.style.color = "#f87171";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "transparent";
              e.currentTarget.style.color = "#3f4654";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
              <path d="M5 2H10M2.5 4.5H12.5M11 4.5L10.3 12.5H4.7L4 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <p style={{ fontSize: "0.865rem", color: "#c8cdd5", lineHeight: 1.65, margin: 0 }}>
        {displayText}
      </p>

      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: "0.45rem",
            background: "none", border: "none", cursor: "pointer",
            fontSize: "0.75rem", color: "#52525b", padding: 0,
          }}
        >
          {expanded ? "Show less ↑" : "Show more ↓"}
        </button>
      )}
    </article>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");

  useEffect(() => {
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => setMemories(data.memories || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const filtered = useMemo(() => {
    let list = [...memories].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    if (platformFilter !== "all") {
      list = list.filter((m) => (m.metadata?.platform || "other").toLowerCase() === platformFilter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((m) => m.text.toLowerCase().includes(q));
    }
    return list;
  }, [memories, platformFilter, query]);

  const platformCounts = useMemo(() => {
    const counts: Record<PlatformFilter, number> = { all: memories.length, claude: 0, chatgpt: 0, gemini: 0, other: 0 };
    for (const m of memories) {
      const p = (m.metadata?.platform || "other").toLowerCase() as PlatformFilter;
      if (p in counts) counts[p]++;
      else counts.other++;
    }
    return counts;
  }, [memories]);

  return (
    <div className="page-stack" style={{ gap: "0" }}>

      {/* ── Header ── */}
      <header style={{ marginBottom: "1.5rem" }}>
        <h2 className="page-title" style={{ marginBottom: "0.25rem" }}>Memories</h2>
        <p className="page-subtitle" style={{ fontSize: "0.84rem" }}>
          Your cross-AI memory graph &mdash; captured from Claude, ChatGPT, and Gemini
        </p>
      </header>

      {/* ── Stats strip ── */}
      <StatsStrip memories={memories} loading={loading} />

      {/* ── Search + filter ── */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: 1, minWidth: "200px" }}>
          <svg
            width="14" height="14" viewBox="0 0 15 15" fill="none"
            style={{ position: "absolute", left: "0.75rem", top: "50%", transform: "translateY(-50%)", color: "#52525b", pointerEvents: "none" }}
            aria-hidden
          >
            <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className="form-input"
            placeholder="Search memories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: "2.2rem" }}
          />
        </div>

        {/* Platform pills */}
        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
          {PLATFORMS.map((p) => {
            const active = platformFilter === p;
            const count = platformCounts[p];
            const style = p !== "all" ? PLATFORM_STYLES[p] : null;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setPlatformFilter(p)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "0.35rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "999px",
                  fontSize: "0.76rem", fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  border: active
                    ? `1px solid ${style?.border ?? "#454545"}`
                    : "1px solid #2a3039",
                  background: active
                    ? (style?.bg ?? "rgba(255,255,255,.08)")
                    : "transparent",
                  color: active
                    ? (style?.color ?? "#fafafa")
                    : "#52525b",
                  transition: "all 0.12s",
                }}
              >
                {p === "all" ? "All" : PLATFORM_STYLES[p].label}
                <span style={{
                  fontSize: "0.66rem",
                  padding: "0 0.3rem",
                  borderRadius: "999px",
                  background: active ? "rgba(0,0,0,.22)" : "#1a1f27",
                  color: active ? "inherit" : "#3f4654",
                }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Memory list ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: "90px", borderRadius: "12px",
              background: "linear-gradient(90deg, #0e1117 25%, #121722 50%, #0e1117 75%)",
              backgroundSize: "200% 100%",
              animation: "shimmer 1.6s infinite",
              border: "1px solid #1f2530",
            }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        memories.length === 0 ? (
          <div style={{ border: "1px solid #1f2530", borderRadius: "12px", background: "#0d1117" }}>
            <EmptyOnboarding />
          </div>
        ) : (
          <div style={{
            padding: "2.5rem 1.5rem", textAlign: "center",
            border: "1px solid #1f2530", borderRadius: "12px",
            background: "#0d1117",
          }}>
            <p style={{ color: "#52525b", fontSize: "0.9rem" }}>No memories match your search.</p>
            <button
              type="button"
              onClick={() => { setQuery(""); setPlatformFilter("all"); }}
              style={{
                marginTop: "0.75rem", background: "none", border: "none",
                cursor: "pointer", color: "#7daf38", fontSize: "0.82rem",
              }}
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
          {filtered.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onDelete={handleDelete} />
          ))}
          {filtered.length > 0 && (
            <p style={{ textAlign: "center", fontSize: "0.74rem", color: "#2e3540", padding: "0.5rem 0" }}>
              {filtered.length} {filtered.length === 1 ? "memory" : "memories"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

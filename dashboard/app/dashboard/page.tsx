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
const PLATFORM_STYLES: Record<string, { label: string; color: string }> = {
  claude:  { label: "Claude",  color: "#c97a3a" },
  chatgpt: { label: "ChatGPT", color: "#5a9fd4" },
  other:   { label: "Other",   color: "#8aa0b8" },
};

const PLATFORM_FILTER_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  claude:  { bg: "rgba(251,146,60,.13)",  color: "#ffc97a", border: "rgba(251,146,60,.28)" },
  chatgpt: { bg: "rgba(96,165,250,.13)",  color: "#a8d4ff", border: "rgba(96,165,250,.28)" },
  other:   { bg: "rgba(148,163,184,.13)", color: "#cbd5e1", border: "rgba(148,163,184,.28)" },
};

function platformStyle(p: string) {
  return PLATFORM_STYLES[(p || "other").toLowerCase()] ?? PLATFORM_STYLES.other;
}

const PLATFORMS = ["all", "claude", "chatgpt", "other"] as const;
type PlatformFilter = typeof PLATFORMS[number];

/* ── Memory text parsing ────────────────────────────────────────── */
/*
 * Stored memory text can look like:
 *   "[ChatGPT] User's Preference for Ice Cream. Key Points: User enjoys ice cream.
 *    Summary: The user expressed a preference for ice cream. Base: User likes ice cream."
 *
 * We extract a clean title and a clean one-sentence body from it.
 */
function parseMemoryText(text: string): { title: string; body: string } {
  // Strip [PLATFORM] prefix
  const stripped = text.replace(/^\[[^\]]+\]\s*/, "").trim();

  // Find structural markers
  const keyIdx   = stripped.search(/key\s*points?:/i);
  const sumIdx   = stripped.search(/summary:/i);
  const baseIdx  = stripped.search(/base:/i);

  // --- Extract title ---
  let title = "";
  if (keyIdx > 0) {
    title = stripped.slice(0, keyIdx).trim().replace(/[.!?]+$/, "");
  } else if (sumIdx > 0) {
    title = stripped.slice(0, sumIdx).trim().replace(/[.!?]+$/, "");
  } else {
    // First sentence or first 80 chars
    const m = stripped.match(/^(.{10,80}?)[.!?]/);
    title = m ? m[1].trim() : stripped.slice(0, 80).trim();
  }
  title = title.slice(0, 90);

  // --- Extract body (prefer Summary section) ---
  let body = "";
  if (sumIdx >= 0) {
    const afterSum = stripped.slice(sumIdx + 8).trim(); // "Summary:".length = 8
    const endIdx = baseIdx > sumIdx ? baseIdx - sumIdx - 8 : afterSum.search(/\n|[A-Z][a-z]+:/);
    body = endIdx > 0 ? afterSum.slice(0, endIdx).trim() : afterSum.trim();
    body = body.replace(/[.!?]+$/, "");
  } else if (keyIdx >= 0) {
    const afterKey = stripped.slice(keyIdx + 11).trim(); // "Key Points:".length = 11
    body = afterKey.split(/\n/)[0].trim().replace(/[.!?]+$/, "");
  } else {
    // Just use text after the title
    body = stripped.slice(title.length).replace(/[.!?]/, "").trim().slice(0, 180);
  }

  // If title ends up empty fall back to raw text slice
  if (!title && body) { title = body.slice(0, 70); body = ""; }
  if (!title) { title = stripped.slice(0, 70); }
  // Don't repeat title in body
  if (body.toLowerCase().startsWith(title.toLowerCase().slice(0, 20))) body = "";

  return { title, body: body.slice(0, 200) };
}

/* ── Keyword extraction ─────────────────────────────────────────── */
const STOPWORDS = new Set([
  "the","and","for","that","with","this","from","your","have","what","when",
  "where","which","into","would","could","should","about","were","been","they",
  "them","there","their","while","also","than","then","just","like","some",
  "more","most","only","very","over","under","after","before","because","using",
  "used","need","want","make","made","will","shall","such","each","every",
  "user","users","memory","memories","tallei","feature","information",
]);

function extractKeywords(text: string): string[] {
  const clean = text
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/key\s*points?:\s*/gi, "")
    .replace(/summary:\s*/gi, "")
    .replace(/base:\s*/gi, "");
  const count = new Map<string, number>();
  for (const word of clean.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) count.set(word, (count.get(word) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
}

/* ── Relative date ───────────────────────────────────────────────── */
function relativeDate(iso: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ── Memory summary bar ─────────────────────────────────────────── */
function MemorySummary({ memories, loading }: { memories: MemoryItem[]; loading: boolean }) {
  const stats = useMemo(() => {
    const platforms = new Set(memories.map((m) => (m.metadata?.platform || "other").toLowerCase()));
    const weekAgo = new Date().getTime() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = memories.filter((m) => new Date(m.createdAt).getTime() > weekAgo).length;
    return { total: memories.length, platforms: platforms.size, thisWeek };
  }, [memories]);

  if (loading) return <div style={{ height: "16px", marginBottom: "1.25rem" }} />;

  return (
    <div className="mem-summary">
      <span className="mem-summary-val">{stats.total} {stats.total === 1 ? "memory" : "memories"}</span>
      <span className="mem-summary-dot" />
      <span className="mem-summary-val">{stats.platforms} {stats.platforms === 1 ? "platform" : "platforms"}</span>
      {stats.thisWeek > 0 && (
        <>
          <span className="mem-summary-dot" />
          <span className="mem-summary-val">{stats.thisWeek} new this week</span>
        </>
      )}
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────── */
function EmptyOnboarding() {
  return (
    <div style={{ padding: "4rem 2rem", textAlign: "center" }}>
      <div style={{
        width: "52px", height: "52px", margin: "0 auto 1.25rem",
        borderRadius: "14px", background: "rgba(142,198,66,.07)",
        border: "1px solid rgba(142,198,66,.15)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(142,198,66,.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Z" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <h3 style={{ fontFamily: "'Syne', sans-serif", fontSize: "1.05rem", fontWeight: 700, color: "#c8d0db", marginBottom: "0.55rem", letterSpacing: "-0.01em" }}>
        Nothing here yet
      </h3>
      <p style={{ fontSize: "0.86rem", color: "#3a4555", maxWidth: "320px", margin: "0 auto 2rem", lineHeight: 1.7 }}>
        Start a conversation in Claude or ChatGPT — Tallei will quietly remember what matters.
      </p>
      <div style={{ display: "flex", gap: "0.65rem", justifyContent: "center", flexWrap: "wrap" }}>
        <Link
          href="/dashboard/setup"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.4rem",
            padding: "0.55rem 1.1rem",
            background: "linear-gradient(145deg, #8ec642, #7daf38)",
            color: "#17220a", fontWeight: 600, fontSize: "0.83rem",
            borderRadius: "8px", textDecoration: "none",
          }}
        >
          Connect an AI
        </Link>
        <a
          href="https://claude.ai"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.38rem",
            padding: "0.55rem 1.1rem",
            background: "transparent", border: "1px solid #1e2735",
            color: "#4e5a6e", fontWeight: 500, fontSize: "0.83rem",
            borderRadius: "8px", textDecoration: "none",
          }}
        >
          Open Claude
          <svg width="10" height="10" viewBox="0 0 15 15" fill="none" aria-hidden>
            <path d="M5 2.5H12.5V10M12.5 2.5L2.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </a>
      </div>
    </div>
  );
}

/* ── Memory note card ───────────────────────────────────────────── */
function MemoryNoteCard({ memory, onDelete }: { memory: MemoryItem; onDelete: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const platform = (memory.metadata?.platform || "other").toLowerCase();
  const style = platformStyle(platform);
  const { title, body } = useMemo(() => parseMemoryText(memory.text || ""), [memory.text]);
  const tags = useMemo(() => extractKeywords(memory.text || ""), [memory.text]);

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
    <article className="mem-note-card">
      {/* Header: platform + delete */}
      <div className="mem-note-header">
        <span className="mem-note-platform" style={{ color: style.color, display: "flex", alignItems: "center", gap: "5px" }}>
          {platform === "claude" && <img src="/claude.svg" alt="" width={14} height={14} />}
          {platform === "chatgpt" && <img src="/chatgpt.svg" alt="" width={14} height={14} />}
          {style.label}
        </span>
        <button
          type="button"
          className="mem-delete"
          onClick={handleDelete}
          disabled={deleting}
          aria-label="Delete memory"
          style={{
            width: "24px", height: "24px",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "1px solid transparent",
            borderRadius: "6px", cursor: "pointer",
            color: "#2e3a4a", transition: "all 0.12s",
            opacity: deleting ? 0.4 : undefined,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(239,68,68,.1)";
            e.currentTarget.style.borderColor = "rgba(239,68,68,.22)";
            e.currentTarget.style.color = "#f87171";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "transparent";
            e.currentTarget.style.color = "#2e3a4a";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 15 15" fill="none" aria-hidden>
            <path d="M5 2H10M2.5 4.5H12.5M11 4.5L10.3 12.5H4.7L4 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Title */}
      <h3 className="mem-note-title">{title}</h3>

      {/* Body */}
      {body && <p className="mem-note-body">{body}</p>}

      {/* Footer */}
      <div className="mem-note-footer">
        {tags.map((t) => (
          <span key={t} className="mem-note-tag">{t}</span>
        ))}
        <span className="mem-note-date">{relativeDate(memory.createdAt)}</span>
      </div>
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
    const counts: Record<PlatformFilter, number> = { all: memories.length, claude: 0, chatgpt: 0, other: 0 };
    for (const m of memories) {
      const p = (m.metadata?.platform || "other").toLowerCase() as PlatformFilter;
      if (p in counts) counts[p]++;
      else counts.other++;
    }
    return counts;
  }, [memories]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* ── Header ── */}
      <header style={{ marginBottom: "0.4rem" }}>
        <h2 className="page-title" style={{ marginBottom: "0.18rem" }}>Memories</h2>
        <p className="page-subtitle">Captured from Claude, ChatGPT, and Gemini</p>
      </header>

      {/* ── Summary ── */}
      <MemorySummary memories={memories} loading={loading} />

      {/* ── Search ── */}
      <div style={{ position: "relative", marginBottom: "0.6rem" }}>
        <svg
          width="13" height="13" viewBox="0 0 15 15" fill="none"
          style={{ position: "absolute", left: "0.8rem", top: "50%", transform: "translateY(-50%)", color: "#2e3a4a", pointerEvents: "none" }}
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
          style={{ paddingLeft: "2.2rem", height: "40px", fontSize: "0.84rem" }}
        />
      </div>

      {/* ── Platform filters ── */}
      <div style={{ display: "flex", gap: "0.28rem", marginBottom: "1.4rem", flexWrap: "wrap" }}>
        {PLATFORMS.map((p) => {
          const active = platformFilter === p;
          const count = platformCounts[p];
          const s = p !== "all" ? PLATFORM_FILTER_STYLES[p] : null;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPlatformFilter(p)}
              style={{
                display: "inline-flex", alignItems: "center", gap: "0.3rem",
                padding: "0.28rem 0.68rem",
                borderRadius: "999px", fontSize: "0.75rem",
                fontWeight: active ? 600 : 400, cursor: "pointer",
                border: active ? `1px solid ${s?.border ?? "#353c47"}` : "1px solid #161e2a",
                background: active ? (s?.bg ?? "rgba(255,255,255,.05)") : "transparent",
                color: active ? (s?.color ?? "#c8d0db") : "#2e3a4a",
                transition: "all 0.12s",
              }}
            >
              {p === "claude" && <img src="/claude.svg" alt="" width={14} height={14} />}
              {p === "chatgpt" && <img src="/chatgpt.svg" alt="" width={14} height={14} />}
              {p === "all" ? "All" : PLATFORM_FILTER_STYLES[p] ? PLATFORM_STYLES[p].label : p}
              <span style={{
                fontSize: "0.64rem", padding: "0 0.26rem", borderRadius: "999px",
                background: active ? "rgba(0,0,0,.2)" : "#111720",
                color: active ? "inherit" : "#1e2a38",
              }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Memory list ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: "108px", borderRadius: "14px",
              background: "linear-gradient(90deg, #0e1219 25%, #121926 50%, #0e1219 75%)",
              backgroundSize: "200% 100%",
              animation: "shimmer 1.6s infinite",
              border: "1px solid #1a2130",
            }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        memories.length === 0 ? (
          <div style={{ border: "1px solid #1a2130", borderRadius: "14px", background: "#0e1219" }}>
            <EmptyOnboarding />
          </div>
        ) : (
          <div style={{
            padding: "3rem 1.5rem", textAlign: "center",
            border: "1px solid #1a2130", borderRadius: "14px", background: "#0e1219",
          }}>
            <p style={{ color: "#2e3a4a", fontSize: "0.88rem" }}>No memories match your search.</p>
            <button
              type="button"
              onClick={() => { setQuery(""); setPlatformFilter("all"); }}
              style={{
                marginTop: "0.6rem", background: "none", border: "none",
                cursor: "pointer", color: "#7daf38", fontSize: "0.81rem",
              }}
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {filtered.map((memory) => (
            <MemoryNoteCard key={memory.id} memory={memory} onDelete={handleDelete} />
          ))}
          {filtered.length > 0 && (
            <p style={{ textAlign: "center", fontSize: "0.7rem", color: "#161e2a", padding: "0.75rem 0 0" }}>
              {filtered.length} {filtered.length === 1 ? "memory" : "memories"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

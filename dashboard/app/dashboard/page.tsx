"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  ChevronDown,
  ListFilter,
  RefreshCw,
  LayoutGrid,
  Clock,
  User,
  FileText,
  Tag,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

interface MemoryItem {
  id: string;
  text: string;
  metadata: Record<string, string>;
  createdAt: string;
}

/* ── Platform styling ──────────────────────────────────────────── */
const PLATFORM_STYLES: Record<string, { label: string; bg: string; color: string; border: string }> = {
  claude:  { label: "Claude", bg: "#fdf8f4", color: "#d97736", border: "#fbdcbd" },
  chatgpt: { label: "ChatGPT", bg: "#f4f9fd", color: "#3b82f6", border: "#bfdbfe" },
  other:   { label: "Other", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
};

function platformStyle(p: string) {
  return PLATFORM_STYLES[(p || "other").toLowerCase()] ?? PLATFORM_STYLES.other;
}

/* ── Memory text parsing ────────────────────────────────────────── */
function parseMemoryText(text: string): { title: string; body: string } {
  const stripped = text.replace(/^\[[^\]]+\]\s*/, "").trim();

  const keyIdx   = stripped.search(/key\s*points?:/i);
  const sumIdx   = stripped.search(/summary:/i);
  const baseIdx  = stripped.search(/base:/i);

  let title = "";
  if (keyIdx > 0) {
    title = stripped.slice(0, keyIdx).trim().replace(/[.!?]+$/, "");
  } else if (sumIdx > 0) {
    title = stripped.slice(0, sumIdx).trim().replace(/[.!?]+$/, "");
  } else {
    const m = stripped.match(/^(.{10,80}?)[.!?]/);
    title = m ? m[1].trim() : stripped.slice(0, 80).trim();
  }
  title = title.slice(0, 90);

  let body = "";
  if (sumIdx >= 0) {
    const afterSum = stripped.slice(sumIdx + 8).trim();
    const endIdx = baseIdx > sumIdx ? baseIdx - sumIdx - 8 : afterSum.search(/\n|[A-Z][a-z]+:/);
    body = endIdx > 0 ? afterSum.slice(0, endIdx).trim() : afterSum.trim();
    body = body.replace(/[.!?]+$/, "");
  } else if (keyIdx >= 0) {
    const afterKey = stripped.slice(keyIdx + 11).trim();
    body = afterKey.split(/\n/)[0].trim().replace(/[.!?]+$/, "");
  } else {
    body = stripped.slice(title.length).replace(/[.!?]/, "").trim().slice(0, 180);
  }

  if (!title && body) { title = body.slice(0, 70); body = ""; }
  if (!title) { title = stripped.slice(0, 70); }
  if (body.toLowerCase().startsWith(title.toLowerCase().slice(0, 20))) body = "";

  return { title, body: body.slice(0, 200) };
}

/* ── Relative date ───────────────────────────────────────────────── */
function relativeDate(iso: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ── Empty state ────────────────────────────────────────────────── */
function EmptyState() {
  return (
    <div style={{
      padding: "4rem 2rem", textAlign: "center",
      background: "var(--surface)", borderRadius: "var(--radius-lg)",
      border: "1px solid var(--border-light)"
    }}>
      <h3 style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--text)", marginBottom: "0.5rem" }}>
        No memories found
      </h3>
      <p style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
        Start chatting with your agents to build memories.
      </p>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchMemories = useCallback(() => {
    setLoading(true);
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => setMemories(data.memories || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      }
    } finally {
      setDeletingId(null);
    }
  }, []);

  const sortedMemories = useMemo(() => {
    return [...memories].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [memories]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", paddingBottom: "3rem" }}>
      
      {/* ── Header Area ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>Memories</h1>
        
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          {/* Date range picker */}
          <button style={{
            display: "inline-flex", alignItems: "center", gap: "0.5rem",
            background: "var(--surface)", border: "1px solid var(--border)",
            padding: "0.4rem 0.8rem", borderRadius: "8px", fontSize: "0.85rem",
            color: "var(--text)", cursor: "pointer", fontWeight: 500
          }}>
            Pick a date range <ChevronDown size={14} />
          </button>

          {/* Segmented control */}
          <div style={{
            display: "flex", alignItems: "center", background: "#f1f5f9",
            padding: "0.2rem", borderRadius: "8px", border: "1px solid var(--border-light)"
          }}>
            {["All Time", "1d", "7d", "30d"].map((label, idx) => (
              <button key={label} style={{
                background: idx === 0 ? "#ffffff" : "transparent",
                border: "none", borderRadius: "6px",
                padding: "0.3rem 0.7rem", fontSize: "0.8rem", fontWeight: idx === 0 ? 600 : 500,
                color: idx === 0 ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                boxShadow: idx === 0 ? "0 1px 3px rgba(0,0,0,0.1)" : "none"
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* Filters */}
          <button style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "var(--surface)", border: "1px solid var(--border)",
            padding: "0.4rem", borderRadius: "8px", color: "var(--text-2)", cursor: "pointer"
          }}>
            <ListFilter size={16} />
          </button>

          {/* Refresh */}
          <button 
            onClick={fetchMemories}
            disabled={loading}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "var(--surface)", border: "1px solid var(--border)",
              padding: "0.4rem", borderRadius: "8px", color: "var(--text-2)", cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1
            }}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* ── Sub-header ── */}
      <div>
        <button style={{
          display: "inline-flex", alignItems: "center", gap: "0.4rem",
          background: "#f1f5f9", border: "1px solid #e2e8f0",
          padding: "0.4rem 0.8rem", borderRadius: "8px", fontSize: "0.85rem",
          color: "var(--text)", cursor: "pointer", fontWeight: 500
        }}>
          <LayoutGrid size={16} style={{ color: "var(--text-muted)" }} /> Overview
        </button>
      </div>

      {/* ── Table Area ── */}
      {loading && memories.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: "64px", borderRadius: "12px",
              background: "linear-gradient(90deg, var(--surface) 25%, #f1f5f9 50%, var(--surface) 75%)",
              backgroundSize: "200% 100%",
              animation: "shimmer 1.6s infinite",
              border: "1px solid var(--border-light)"
            }} />
          ))}
        </div>
      ) : sortedMemories.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          boxShadow: "none"
        }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-light)", background: "#fafafa" }}>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "120px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Clock size={14} /> Time</div>
                </th>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "160px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><User size={14} /> Entities</div>
                </th>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><FileText size={14} /> Memory Content</div>
                </th>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "140px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Tag size={14} /> Categories</div>
                </th>
                <th style={{ padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "60px", textAlign: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>Action</div>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedMemories.map((memory) => {
                const platform = (memory.metadata?.platform || "other").toLowerCase();
                const style = platformStyle(platform);
                const { title, body } = parseMemoryText(memory.text || "");
                const isDeleting = deletingId === memory.id;

                return (
                  <tr key={memory.id} style={{ 
                    borderBottom: "1px solid var(--border-light)",
                    opacity: isDeleting ? 0.5 : 1,
                    transition: "opacity 0.2s"
                  }}>
                    {/* Time */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", fontSize: "0.85rem", color: "var(--text-2)", verticalAlign: "top" }}>
                      {relativeDate(memory.createdAt)}
                    </td>

                    {/* Entities */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", verticalAlign: "top" }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: "0.3rem",
                        padding: "0.2rem 0.5rem", borderRadius: "6px",
                        fontSize: "0.75rem", fontWeight: 600,
                        background: style.bg, color: style.color, border: `1px solid ${style.border}`
                      }}>
                        <User size={12} /> {style.label}
                      </span>
                    </td>

                    {/* Content */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", verticalAlign: "top" }}>
                      <div style={{ fontWeight: 600, color: "var(--text)", fontSize: "0.9rem", marginBottom: "0.2rem" }}>
                        {title}
                      </div>
                      {body && (
                        <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", lineHeight: 1.5 }}>
                          {body}
                        </div>
                      )}
                    </td>

                    {/* Categories */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", fontSize: "0.85rem", color: "var(--text-muted)", verticalAlign: "top" }}>
                      —
                    </td>

                    {/* Action */}
                    <td style={{ padding: "1rem", verticalAlign: "middle", textAlign: "center" }}>
                      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
                        <button
                          onClick={() => handleDelete(memory.id)}
                          disabled={isDeleting}
                          title="Delete memory"
                          style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            background: "transparent", border: "none", cursor: isDeleting ? "not-allowed" : "pointer",
                            color: "#94a3b8", padding: "0.4rem", borderRadius: "6px", transition: "all 0.15s"
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#fee2e2";
                            e.currentTarget.style.color = "#ef4444";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = "#94a3b8";
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

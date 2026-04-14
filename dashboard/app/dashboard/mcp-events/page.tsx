"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ChevronDown,
  ListFilter,
  RefreshCw,
  LayoutGrid,
  Clock,
  User,
  FileText,
  Activity
} from "lucide-react";

type McpEvent = {
  id: string;
  authMode: string | null;
  method: string;
  toolName: string | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
};

/* ── Platform styling ──────────────────────────────────────────── */
const PLATFORM_STYLES: Record<string, { label: string; bg: string; color: string; border: string }> = {
  claude:  { label: "Claude", bg: "#fdf8f4", color: "#d97736", border: "#fbdcbd" },
  chatgpt: { label: "ChatGPT", bg: "#f4f9fd", color: "#3b82f6", border: "#bfdbfe" },
  other:   { label: "Other", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
};

function platformStyle(p: string) {
  return PLATFORM_STYLES[(p || "other").toLowerCase()] ?? PLATFORM_STYLES.other;
}

/* ── Relative date ───────────────────────────────────────────────── */
function relativeDate(iso: string, now: number): string {
  if (!iso || !now) return "—";
  const diff = now - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
        No MCP events yet
      </h3>
      <p style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
        Send a message to your AI assistant and refresh this page to see the activity log.
      </p>
    </div>
  );
}

export default function McpEventsPage() {
  const [events, setEvents] = useState<McpEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState<number>(Date.now());

  const fetchEvents = useCallback(() => {
    setLoading(true);
    fetch("/api/mcp-events?limit=100")
      .then((res) => res.json())
      .then((data) => setEvents(data.events || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchEvents();
    
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", paddingBottom: "3rem" }}>
      
      {/* ── Header Area ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>Activity</h1>
        
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
            onClick={fetchEvents}
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
      {loading && events.length === 0 ? (
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
      ) : events.length === 0 ? (
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
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "140px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Clock size={14} /> Time</div>
                </th>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "140px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><User size={14} /> Platform</div>
                </th>
                <th style={{ borderRight: "1px solid var(--border-light)", padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Activity size={14} /> Action</div>
                </th>
                <th style={{ padding: "0.8rem 1rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", width: "200px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><FileText size={14} /> Details</div>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const platform = event.authMode || "other";
                const style = platformStyle(platform);
                const isSuccess = event.ok;

                return (
                  <tr key={event.id} style={{ 
                    borderBottom: "1px solid var(--border-light)",
                    transition: "background 0.2s"
                  }}>
                    {/* Time */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", fontSize: "0.85rem", color: "var(--text-2)", verticalAlign: "top" }}>
                      {now ? relativeDate(event.createdAt, now) : "..."}
                    </td>

                    {/* Platform */}
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

                    {/* Action */}
                    <td style={{ borderRight: "1px solid var(--border-light)", padding: "1rem", verticalAlign: "top" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
                         <span style={{
                           padding: "0.15rem 0.4rem", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600,
                           background: isSuccess ? "#e6f5c8" : "#fee2e2",
                           color: isSuccess ? "#3d5c18" : "#ef4444",
                           border: isSuccess ? "1px solid #cce89e" : "1px solid #fecaca"
                         }}>
                           {isSuccess ? "200 OK" : "ERROR"}
                         </span>
                      </div>
                      <div style={{ fontWeight: 600, color: "var(--text)", fontSize: "0.9rem", fontFamily: "monospace", display: "inline-block", padding: "0.2rem 0.4rem", background: "#f1f5f9", borderRadius: "4px", border: "1px solid var(--border-light)" }}>
                        {event.toolName || event.method}
                      </div>
                    </td>

                    {/* Details / Error */}
                    <td style={{ padding: "1rem", fontSize: "0.85rem", color: "var(--text-muted)", verticalAlign: "top" }}>
                      {event.error ? (
                        <div style={{
                          color: "#ef4444", background: "#fef2f2",
                          padding: "0.5rem", borderRadius: "6px",
                          border: "1px solid #fee2e2",
                          fontSize: "0.8rem", fontFamily: "monospace",
                          maxHeight: "80px", overflowY: "auto",
                          wordBreak: "break-all"
                        }}>
                          {event.error}
                        </div>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
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

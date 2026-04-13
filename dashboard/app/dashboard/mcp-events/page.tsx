"use client";

import { useEffect, useState } from "react";

type McpEvent = {
  id: string;
  authMode: string | null;
  method: string;
  toolName: string | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
};

function formatTime(iso: string, now: number) {
  if (!iso) return "—";
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

export default function McpEventsPage() {
  const [events, setEvents] = useState<McpEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState<number>(0);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    const t = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60000);
    }, 10);
    
    fetch("/api/mcp-events?limit=100")
      .then((res) => res.json())
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));

    return () => {
      clearTimeout(t);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <section>
        <h2 className="page-title">Activity</h2>
        <p className="page-subtitle">Live log of MCP tool calls — use this to confirm Claude is saving and recalling memory.</p>
      </section>

      {loading ? (
        <article className="memory-card">Loading MCP events...</article>
      ) : events.length === 0 ? (
        <div className="container-tags-empty">
          <h3 className="container-tags-empty-title" style={{ fontSize: "1.25rem" }}>No MCP events yet</h3>
          <p className="container-tags-empty-subtitle">Send a Claude message and refresh this page.</p>
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #1a2130", borderRadius: "10px", background: "#0c1015" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem", color: "#dbe2ec" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1a2130", color: "#6b7a90", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", background: "#0e1219" }}>
                <th style={{ padding: "1rem 1.25rem", fontWeight: 600 }}>Type</th>
                <th style={{ padding: "1rem 1.25rem", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "1rem 1.25rem", fontWeight: 600 }}>Platform</th>
                <th style={{ padding: "1rem 1.25rem", fontWeight: 600 }}>Time</th>
                <th style={{ padding: "1rem 1.25rem", fontWeight: 600 }}>Document</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} style={{ borderBottom: "1px solid #1a2130", background: "transparent" }}>
                  <td style={{ padding: "0.85rem 1.25rem" }}>
                    <span style={{ background: "rgba(255,255,255,0.06)", padding: "0.2rem 0.5rem", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.05)", color: "#aab4c0", fontSize: "0.8rem" }}>
                      {event.toolName || event.method}
                    </span>
                  </td>
                  <td style={{ padding: "0.85rem 1.25rem" }}>
                    <span
                      style={{
                        background: event.ok ? "rgba(109,211,141,0.12)" : "rgba(255,120,120,0.12)",
                        color: event.ok ? "#9beab4" : "#ffb4b4",
                        padding: "0.2rem 0.5rem", borderRadius: "4px", fontSize: "0.8rem", fontWeight: 500,
                        border: event.ok ? "1px solid rgba(109,211,141,0.2)" : "1px solid rgba(255,120,120,0.2)"
                      }}
                    >
                      {event.ok ? "200" : "ERROR"}
                    </span>
                  </td>
                  <td style={{ padding: "0.85rem 1.25rem" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "#aab4c0", textTransform: "capitalize" }}>
                      {event.authMode === "claude" && <img src="/claude.svg" alt="" width={14} height={14} />}
                      {event.authMode === "chatgpt" && <img src="/chatgpt.svg" alt="" width={14} height={14} />}
                      {event.authMode || "unknown"}
                    </div>
                  </td>
                  <td style={{ padding: "0.85rem 1.25rem", color: "#8a96a8" }}>
                    {now ? formatTime(event.createdAt, now) : "..."}
                  </td>
                  <td style={{ padding: "0.85rem 1.25rem", color: "#8a96a8", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {event.error || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


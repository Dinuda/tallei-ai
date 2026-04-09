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

export default function McpEventsPage() {
  const [events, setEvents] = useState<McpEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/mcp-events?limit=100")
      .then((res) => res.json())
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <section>
        <h2 className="page-title">MCP Events</h2>
        <p className="page-subtitle">Use this to confirm whether Claude is actually calling memory tools.</p>
      </section>

      {loading ? (
        <article className="memory-card">Loading MCP events...</article>
      ) : events.length === 0 ? (
        <div className="container-tags-empty">
          <h3 className="container-tags-empty-title" style={{ fontSize: "1.25rem" }}>No MCP events yet</h3>
          <p className="container-tags-empty-subtitle">Send a Claude message and refresh this page.</p>
        </div>
      ) : (
        events.map((event) => (
          <article key={event.id} className="memory-card">
            <div className="memory-card-head">
              <div style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                <span className="platform-chip" style={{ background: "rgba(64,148,255,0.18)", color: "#8dc2ff" }}>
                  {event.method}
                </span>
                <span className="platform-chip" style={{ background: "rgba(143,196,67,0.18)", color: "#c3e58a" }}>
                  {event.toolName || "n/a"}
                </span>
                <span className="platform-chip" style={{ background: "rgba(255,255,255,0.08)", color: "#d7dbe3" }}>
                  {event.authMode || "unknown"}
                </span>
                <span
                  className="platform-chip"
                  style={{
                    background: event.ok ? "rgba(109,211,141,0.2)" : "rgba(255,120,120,0.2)",
                    color: event.ok ? "#9beab4" : "#ffb4b4",
                  }}
                >
                  {event.ok ? "ok" : "error"}
                </span>
              </div>

              <span className="memory-date">
                {new Date(event.createdAt).toLocaleString()}
              </span>
            </div>

            {event.error ? <p className="memory-text">{event.error}</p> : null}
          </article>
        ))
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";

interface MemoryItem {
  id: string;
  text: string;
  metadata: Record<string, string>;
  createdAt: string;
}

const PLATFORM_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  claude: { bg: "rgba(251, 146, 60, 0.14)", color: "#ffca97", border: "rgba(251, 146, 60, 0.34)" },
  chatgpt: { bg: "rgba(96, 165, 250, 0.14)", color: "#b8d9ff", border: "rgba(96, 165, 250, 0.34)" },
  gemini: { bg: "rgba(168, 85, 247, 0.14)", color: "#dcc4ff", border: "rgba(168, 85, 247, 0.34)" },
  api: { bg: "#171c24", color: "#d0d5dd", border: "#2f3640" },
};

function platformStyle(platform: string) {
  const key = (platform || "api").toLowerCase();
  return PLATFORM_COLORS[key] || PLATFORM_COLORS.api;
}

export default function DashboardPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => setMemories(data.memories || []))
      .catch((error) => console.error("Failed to fetch memories:", error))
      .finally(() => setLoading(false));
  }, []);

  const recentMemories = useMemo(
    () => [...memories].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 8),
    [memories],
  );

  return (
    <div className="page-stack" style={{ gap: "0.9rem" }}>
      <header>
        <h2 className="page-title">Container Tags</h2>
        <p className="page-subtitle">
          Container tags organize your documents and memories
        </p>
      </header>

      <section className="container-tags-panel">
        {loading ? (
          <div className="container-tags-center">
            <p className="page-subtitle">Loading memories...</p>
          </div>
        ) : recentMemories.length === 0 ? (
          <div className="container-tags-center">
            <svg width="32" height="32" viewBox="0 0 15 15" fill="none" aria-hidden>
              <path d="M8.8 1.7H13.3V6.2L7.4 12.1L2.9 7.6L8.8 1.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <circle cx="10.9" cy="4.1" r="0.8" fill="currentColor" />
            </svg>
            <h3 className="container-tags-empty-title">No container tags yet</h3>
            <p className="container-tags-empty-subtitle">
              Import data or add documents via the API to get started.
            </p>
          </div>
        ) : (
          <div className="list-stack" style={{ gap: "0.6rem" }}>
            {recentMemories.map((memory) => {
              const style = platformStyle(memory.metadata?.platform);
              return (
                <article key={memory.id} className="memory-card" style={{ padding: "0.85rem 0.95rem" }}>
                  <div className="memory-card-head" style={{ marginBottom: "0.45rem" }}>
                    <span
                      className="platform-chip"
                      style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}` }}
                    >
                      {memory.metadata?.platform || "API"}
                    </span>
                    <span className="memory-date">
                      {memory.createdAt
                        ? new Date(memory.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : "-"}
                    </span>
                  </div>
                  <p className="memory-text">{memory.text}</p>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

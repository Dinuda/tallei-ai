"use client";

import { useEffect, useMemo, useState } from "react";

type MemoryItem = {
  id: string;
  text: string;
  metadata?: Record<string, string>;
  createdAt: string;
};

type MemoryCard = MemoryItem & {
  score: number;
  platform: string;
  category: string;
  keywords: string[];
};

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "your", "have", "what", "when", "where", "which", "into",
  "would", "could", "should", "about", "were", "been", "they", "them", "there", "their", "while", "also", "than",
  "then", "just", "like", "some", "more", "most", "only", "very", "over", "under", "after", "before", "because",
  "using", "used", "need", "want", "make", "made", "will", "shall", "such", "each", "every", "other", "across",
]);

function extractKeywords(text: string) {
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
    .slice(0, 4)
    .map(([word]) => word);
}

function inferCategory(memory: MemoryItem) {
  const source = `${memory.text} ${JSON.stringify(memory.metadata || {})}`.toLowerCase();
  if (source.includes("project") || source.includes("task") || source.includes("deadline")) return "work";
  if (source.includes("product") || source.includes("feature") || source.includes("roadmap")) return "product";
  if (source.includes("preference") || source.includes("likes") || source.includes("style")) return "profile";
  if (source.includes("api") || source.includes("token") || source.includes("auth")) return "technical";
  return "general";
}

function importanceScore(memory: MemoryItem) {
  const text = memory.text || "";
  const recencyDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  const recency = Math.max(0, 1 - recencyDays / 30);
  const lengthFactor = Math.min(1, text.length / 350);
  const signalFactor = Math.min(1, (extractKeywords(text).length + (memory.metadata?.platform ? 1 : 0)) / 6);
  return Math.round((recency * 0.4 + lengthFactor * 0.3 + signalFactor * 0.3) * 100);
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => setMemories(data.memories || []))
      .catch((error) => console.error("Failed to fetch memories:", error))
      .finally(() => setLoading(false));
  }, []);

  const enriched = useMemo<MemoryCard[]>(() => {
    return memories.map((memory) => ({
      ...memory,
      platform: (memory.metadata?.platform || "api").toLowerCase(),
      category: inferCategory(memory),
      keywords: extractKeywords(memory.text || ""),
      score: importanceScore(memory),
    }));
  }, [memories]);

  const filtered = useMemo(() => {
    if (!query.trim()) return enriched;
    const q = query.toLowerCase();
    return enriched.filter((memory) => {
      const haystack = `${memory.text} ${memory.category} ${memory.platform} ${memory.keywords.join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [enriched, query]);

  const summary = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const memory of enriched) {
      byCategory.set(memory.category, (byCategory.get(memory.category) || 0) + 1);
    }

    const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "general";
    const avgScore = enriched.length > 0 ? Math.round(enriched.reduce((sum, m) => sum + m.score, 0) / enriched.length) : 0;

    return {
      total: enriched.length,
      topCategory,
      avgScore,
      highSignal: enriched.filter((m) => m.score >= 70).length,
    };
  }, [enriched]);

  return (
    <div className="page-stack">
      <header>
        <h2 className="page-title">Memory</h2>
        <p className="page-subtitle">mem0-style memory intelligence layer with semantic ranking and retrieval.</p>
      </header>

      <section className="memory-kpi-grid">
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Total Memories</p>
          <p className="memory-kpi-value">{summary.total}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Avg Importance</p>
          <p className="memory-kpi-value">{summary.avgScore}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Top Category</p>
          <p className="memory-kpi-value" style={{ textTransform: "capitalize" }}>{summary.topCategory}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">High Signal</p>
          <p className="memory-kpi-value">{summary.highSignal}</p>
        </article>
      </section>

      <section className="panel">
        <div className="search-input-wrap" style={{ marginBottom: 0 }}>
          <svg className="search-icon" width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
            <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className="form-input"
            placeholder="Search memories, tags, category, platform..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </section>

      <section className="list-stack">
        {loading ? (
          <article className="memory-card">Loading memory intelligence...</article>
        ) : filtered.length === 0 ? (
          <article className="empty-state-panel" style={{ minHeight: "220px" }}>
            <h3 className="container-tags-empty-title" style={{ fontSize: "1.3rem" }}>No memory matches found</h3>
            <p className="container-tags-empty-subtitle">Try a broader query or add new conversations to your memory index.</p>
          </article>
        ) : (
          filtered.map((memory) => (
            <article key={memory.id} className="memory-card">
              <div className="memory-card-head">
                <div style={{ display: "inline-flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
                  <span className="platform-chip" style={{ border: "1px solid #343b46", background: "#181e27", color: "#dbe2ec", textTransform: "uppercase" }}>
                    {memory.platform}
                  </span>
                  <span className="platform-chip" style={{ border: "1px solid #3b422f", background: "rgba(143,196,67,0.16)", color: "#d8efb6", textTransform: "uppercase" }}>
                    {memory.category}
                  </span>
                </div>
                <span className="memory-date">Importance {memory.score}</span>
              </div>

              <p className="memory-text" style={{ marginBottom: "0.7rem" }}>{memory.text}</p>

              <div style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {memory.keywords.map((keyword) => (
                  <span key={`${memory.id}-${keyword}`} className="memory-keyword-chip">{keyword}</span>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}

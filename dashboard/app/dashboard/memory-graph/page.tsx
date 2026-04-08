"use client";

import { useEffect, useMemo, useState } from "react";

type MemoryItem = {
  id: string;
  text: string;
  metadata?: Record<string, string>;
  createdAt: string;
};

type GraphNode = {
  id: string;
  label: string;
  kind: "memory" | "keyword" | "platform";
  x: number;
  y: number;
  weight: number;
};

type GraphEdge = {
  from: string;
  to: string;
};

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "your", "have", "what", "when", "where", "which", "into",
  "would", "could", "should", "about", "were", "been", "they", "them", "there", "their", "while", "also", "than",
  "then", "just", "like", "some", "more", "most", "only", "very", "over", "under", "after", "before", "because",
  "using", "used", "need", "want", "make", "made", "will", "shall", "such", "each", "every", "other", "across",
]);

function extractKeywords(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
    .slice(0, 4);
}

function buildGraph(memories: MemoryItem[]) {
  const latest = [...memories]
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 16);

  const keywordFrequency = new Map<string, number>();
  const platformFrequency = new Map<string, number>();

  for (const memory of latest) {
    const platform = (memory.metadata?.platform || "api").toLowerCase();
    platformFrequency.set(platform, (platformFrequency.get(platform) || 0) + 1);
    for (const keyword of extractKeywords(memory.text || "")) {
      keywordFrequency.set(keyword, (keywordFrequency.get(keyword) || 0) + 1);
    }
  }

  const keywords = [...keywordFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const platforms = [...platformFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const centerX = 420;
  const centerY = 230;

  latest.forEach((memory, index) => {
    const angle = (index / Math.max(1, latest.length)) * Math.PI * 2;
    const radius = 130;
    nodes.push({
      id: `m:${memory.id}`,
      label: memory.text.slice(0, 28).trim() || "memory",
      kind: "memory",
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      weight: 1,
    });
  });

  keywords.forEach(([keyword, freq], index) => {
    const angle = (index / Math.max(1, keywords.length)) * Math.PI * 2;
    const radius = 210;
    nodes.push({
      id: `k:${keyword}`,
      label: keyword,
      kind: "keyword",
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      weight: freq,
    });
  });

  platforms.forEach(([platform, freq], index) => {
    const angle = (index / Math.max(1, platforms.length)) * Math.PI * 2 + Math.PI / 6;
    const radius = 280;
    nodes.push({
      id: `p:${platform}`,
      label: platform,
      kind: "platform",
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      weight: freq,
    });
  });

  for (const memory of latest) {
    const memoryId = `m:${memory.id}`;
    const platform = (memory.metadata?.platform || "api").toLowerCase();
    edges.push({ from: memoryId, to: `p:${platform}` });

    const memoryKeywords = extractKeywords(memory.text || "");
    for (const keyword of memoryKeywords) {
      if (keywords.some(([k]) => k === keyword)) {
        edges.push({ from: memoryId, to: `k:${keyword}` });
      }
    }
  }

  return { nodes, edges, memoryCount: latest.length, keywordCount: keywords.length, platformCount: platforms.length };
}

function nodeColor(kind: GraphNode["kind"]) {
  if (kind === "memory") return "#8fc443";
  if (kind === "platform") return "#5fa8ff";
  return "#c0c7d2";
}

export default function MemoryGraphPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => setMemories(data.memories || []))
      .catch((error) => console.error("Failed to fetch memories:", error))
      .finally(() => setLoading(false));
  }, []);

  const graph = useMemo(() => buildGraph(memories), [memories]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  return (
    <div className="page-stack">
      <header>
        <h2 className="page-title">Memory Graph</h2>
        <p className="page-subtitle">Semantic relationship map inspired by mem0 graph memory retrieval.</p>
      </header>

      <section className="memory-kpi-grid">
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Memory Nodes</p>
          <p className="memory-kpi-value">{graph.memoryCount}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Keyword Nodes</p>
          <p className="memory-kpi-value">{graph.keywordCount}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Platform Nodes</p>
          <p className="memory-kpi-value">{graph.platformCount}</p>
        </article>
        <article className="memory-kpi-card">
          <p className="memory-kpi-label">Edges</p>
          <p className="memory-kpi-value">{graph.edges.length}</p>
        </article>
      </section>

      <section className="memory-graph-panel">
        {loading ? (
          <div className="container-tags-center">
            <p className="page-subtitle">Building graph...</p>
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="container-tags-center">
            <h3 className="container-tags-empty-title" style={{ fontSize: "1.3rem" }}>No memory graph data yet</h3>
            <p className="container-tags-empty-subtitle">Capture memories first, then semantic links will appear here.</p>
          </div>
        ) : (
          <div className="memory-graph-canvas-wrap">
            <svg viewBox="0 0 840 460" className="memory-graph-canvas" role="img" aria-label="Memory graph">
              <g>
                {graph.edges.map((edge, index) => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={`${edge.from}-${edge.to}-${index}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="#2e3642"
                      strokeWidth="1"
                      opacity="0.7"
                    />
                  );
                })}
              </g>

              <g>
                {graph.nodes.map((node) => {
                  const radius = node.kind === "memory" ? 9 : node.kind === "platform" ? 7 : 6;
                  return (
                    <g key={node.id}>
                      <circle cx={node.x} cy={node.y} r={radius} fill={nodeColor(node.kind)} opacity="0.92" />
                      <text
                        x={node.x}
                        y={node.y - radius - 6}
                        textAnchor="middle"
                        fill="#d3d9e2"
                        fontSize="10"
                        fontFamily="Inter, sans-serif"
                      >
                        {node.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>

            <div className="memory-graph-legend">
              <span><i style={{ background: "#8fc443" }} />Memory</span>
              <span><i style={{ background: "#c0c7d2" }} />Keyword</span>
              <span><i style={{ background: "#5fa8ff" }} />Platform</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

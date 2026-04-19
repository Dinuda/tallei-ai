"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type GraphNode = {
  id: string;
  label: string;
  kind: "memory" | "entity" | "platform";
  weight: number;
};

type GraphEdge = {
  from: string;
  to: string;
  kind: "mention" | "relation" | "platform";
  confidenceLabel?: "explicit" | "inferred" | "uncertain";
};

type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  panels: {
    topEntities: Array<{ label: string; mentions: number }>;
    strongestRelations: Array<{
      source: string;
      target: string;
      relationType: string;
      confidence: number;
      confidenceLabel: string;
    }>;
    uncertainRelations: number;
  };
};

type InsightsPayload = {
  generatedAt: string;
  summary: {
    contradictionCount: number;
    staleDecisionCount: number;
    highImpactCount: number;
    uncertainRelationCount: number;
  };
  contradictions: Array<{
    source: string;
    relationType: string;
    targets: Array<{ label: string; confidence: number; lastSeenAt: string }>;
    severity: "low" | "medium" | "high";
  }>;
  staleDecisions: Array<{
    source: string;
    target: string;
    relationType: string;
    daysSinceSeen: number;
    lastSeenAt: string;
    recommendation: string;
  }>;
  highImpactRelationships: Array<{
    source: string;
    target: string;
    relationType: string;
    confidence: number;
    confidenceLabel: string;
    impactScore: number;
    why: string;
  }>;
  recommendations: string[];
};

type PositionedNode = GraphNode & { x: number; y: number };

function edgeStroke(edge: GraphEdge): string {
  if (edge.kind === "platform") return "#94a3b8";
  if (edge.kind === "mention") return "#64748b";
  if (edge.confidenceLabel === "explicit") return "#16a34a";
  if (edge.confidenceLabel === "uncertain") return "#f59e0b";
  return "#3b82f6";
}

function nodeColor(kind: GraphNode["kind"]): string {
  if (kind === "memory") return "#65a30d";
  if (kind === "platform") return "#2563eb";
  return "#94a3b8";
}

function positionNodes(nodes: GraphNode[]): PositionedNode[] {
  const viewBoxW = 900;
  const viewBoxH = 520;
  const memory = nodes.filter((node) => node.kind === "memory");
  const entities = nodes.filter((node) => node.kind === "entity");
  const platforms = nodes.filter((node) => node.kind === "platform");

  const centerX = viewBoxW / 2;
  const centerY = viewBoxH / 2;
  const positioned: PositionedNode[] = [];

  memory.forEach((node, index) => {
    const angle = (index / Math.max(1, memory.length)) * Math.PI * 2;
    const radius = 130;
    positioned.push({
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });

  entities.forEach((node, index) => {
    const angle = (index / Math.max(1, entities.length)) * Math.PI * 2;
    const radius = 220;
    positioned.push({
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });

  platforms.forEach((node, index) => {
    const angle = (index / Math.max(1, platforms.length)) * Math.PI * 2 + Math.PI / 4;
    const radius = 310;
    positioned.push({
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });

  return positioned;
}

function nodeRadius(kind: GraphNode["kind"]): number {
  if (kind === "memory") return 10;
  if (kind === "platform") return 8;
  return 7;
}

function truncate(value: string, size: number): string {
  if (value.length <= size) return value;
  return `${value.slice(0, size - 1)}…`;
}

function nodeKindLabel(kind: GraphNode["kind"]): string {
  if (kind === "memory") return "Memory";
  if (kind === "platform") return "Platform";
  return "Entity";
}

const EMPTY_GRAPH: GraphPayload = {
  nodes: [],
  edges: [],
  panels: { topEntities: [], strongestRelations: [], uncertainRelations: 0 },
};

export default function MemoryGraphPage() {
  const [payload, setPayload] = useState<GraphPayload>(EMPTY_GRAPH);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const [graphResult, insightResult] = await Promise.allSettled([
        fetch("/api/memories/graph").then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            if (res.status === 404) {
              return {
                payload: EMPTY_GRAPH,
                disabledMessage:
                  data.error ??
                  "Memory graph is disabled. Enable GRAPH_EXTRACTION_ENABLED=true and DASHBOARD_GRAPH_V2_ENABLED=true.",
              };
            }
            throw new Error(`graph request failed (${res.status})`);
          }
          return { payload: data as GraphPayload, disabledMessage: null as string | null };
        }),
        fetch("/api/memories/insights").then(async (res) => {
          if (res.status === 404) return null;
          if (!res.ok) return null;
          return (await res.json()) as InsightsPayload;
        }),
      ]);

      if (cancelled) return;

      if (graphResult.status === "fulfilled") {
        setPayload(graphResult.value.payload);
        if (graphResult.value.disabledMessage) {
          setError(graphResult.value.disabledMessage);
        }
      } else {
        setPayload(EMPTY_GRAPH);
        setError("Graph data is unavailable right now.");
        console.error("Failed to fetch memory graph:", graphResult.reason);
      }

      if (insightResult.status === "fulfilled") {
        setInsights(insightResult.value);
      } else {
        setInsights(null);
        console.error("Failed to fetch memory insights:", insightResult.reason);
      }
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const nodes = useMemo(() => positionNodes(payload.nodes ?? []), [payload.nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = useMemo(() => payload.edges ?? [], [payload.edges]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const node of nodes) {
      map.set(node.id, new Set());
    }
    for (const edge of edges) {
      const from = map.get(edge.from);
      const to = map.get(edge.to);
      if (from) from.add(edge.to);
      if (to) to.add(edge.from);
    }
    return map;
  }, [edges, nodes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    return new Set(adjacency.get(selectedNodeId) ?? []);
  }, [adjacency, selectedNodeId]);

  const selectedConnections = useMemo(() => {
    if (!selectedNodeId) return [];
    const neighbors = [...(adjacency.get(selectedNodeId) ?? [])];
    return neighbors
      .map((id) => nodeById.get(id))
      .filter((item): item is PositionedNode => Boolean(item))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8);
  }, [adjacency, nodeById, selectedNodeId]);

  const edgeCountByKind = useMemo(() => {
    const count = { relation: 0, mention: 0, platform: 0 };
    for (const edge of edges) {
      count[edge.kind] += 1;
    }
    return count;
  }, [edges]);

  return (
    <div className={styles.page}>
      <header>
        <h2 className="page-title">Memory Graph</h2>
        <p className="page-subtitle">
          Persisted entity-memory network with confidence-aware links and operational insights.
        </p>
      </header>

      <section className={styles.kpiGrid}>
        <article className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Nodes</p>
          <p className={styles.kpiValue}>{payload.nodes.length}</p>
        </article>
        <article className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Edges</p>
          <p className={styles.kpiValue}>{payload.edges.length}</p>
        </article>
        <article className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Top Entities</p>
          <p className={styles.kpiValue}>{payload.panels.topEntities.length}</p>
        </article>
        <article className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Uncertain Links</p>
          <p className={styles.kpiValue}>{payload.panels.uncertainRelations}</p>
        </article>
      </section>

      <section className={styles.graphGrid}>
        <article className={styles.graphCard}>
          <div className={styles.cardHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Live Graph View</h3>
              <p className={styles.sectionSubtle}>Click nodes to focus local neighborhoods.</p>
            </div>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setSelectedNodeId(null)}
              disabled={!selectedNodeId}
            >
              Clear Focus
            </button>
          </div>

          <div className={styles.graphCanvasWrap}>
            {loading ? (
              <div className={styles.centerState}>
                <p className="page-subtitle">Loading graph...</p>
              </div>
            ) : nodes.length === 0 ? (
              <div className={styles.centerState}>
                <h3 className={styles.emptyTitle}>Graph data is not available yet</h3>
                <p className={styles.emptySubtitle}>
                  Enable graph extraction and let workers process saved memories.
                </p>
                {error ? <p className={styles.errorText}>{error}</p> : null}
              </div>
            ) : (
              <svg viewBox="0 0 900 520" className={styles.graphCanvas} role="img" aria-label="Memory graph">
                <defs>
                  <pattern id="memory-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                    <path d="M 28 0 L 0 0 0 28" fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect x="0" y="0" width="900" height="520" fill="url(#memory-grid)" />
                <g>
                  {edges.map((edge, index) => {
                    const from = nodeById.get(edge.from);
                    const to = nodeById.get(edge.to);
                    if (!from || !to) return null;

                    const isFocused =
                      !selectedNodeId || edge.from === selectedNodeId || edge.to === selectedNodeId;

                    return (
                      <line
                        key={`${edge.from}-${edge.to}-${index}`}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        stroke={edgeStroke(edge)}
                        strokeWidth={edge.kind === "relation" ? 1.5 : 1.1}
                        opacity={isFocused ? (edge.kind === "relation" ? 0.8 : 0.6) : 0.1}
                        strokeDasharray={edge.kind === "platform" ? "5 3" : undefined}
                      />
                    );
                  })}
                </g>
                <g>
                  {nodes.map((node) => {
                    const radius = nodeRadius(node.kind);
                    const active =
                      !selectedNodeId ||
                      node.id === selectedNodeId ||
                      selectedNeighbors.has(node.id);
                    const selected = node.id === selectedNodeId;
                    return (
                      <g
                        key={node.id}
                        onClick={() => setSelectedNodeId(node.id)}
                        className={styles.nodeGroup}
                        aria-label={`${node.label} node`}
                      >
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={radius}
                          fill={nodeColor(node.kind)}
                          opacity={active ? 0.92 : 0.26}
                          stroke={selected ? "#0f172a" : "rgba(15,23,42,0.22)"}
                          strokeWidth={selected ? 2.4 : 1.2}
                        />
                        <text
                          x={node.x}
                          y={node.y - radius - 7}
                          textAnchor="middle"
                          fill={active ? "#334155" : "#94a3b8"}
                          fontSize="10"
                          fontFamily="'SF Pro Display', 'Plus Jakarta Sans', sans-serif"
                        >
                          {truncate(node.label, 20)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
            )}
          </div>

          <div className={styles.legend}>
            <span><i style={{ background: "#65a30d" }} /> Memory</span>
            <span><i style={{ background: "#94a3b8" }} /> Entity</span>
            <span><i style={{ background: "#2563eb" }} /> Platform</span>
            <span><i style={{ background: "#16a34a" }} /> Explicit Relation</span>
            <span><i style={{ background: "#f59e0b" }} /> Uncertain Relation</span>
          </div>
        </article>

        <aside className={styles.sideRail}>
          <article className={styles.sideCard}>
            <p className={styles.cardKicker}>Focus</p>
            {selectedNode ? (
              <>
                <h4 className={styles.focusTitle}>{selectedNode.label}</h4>
                <p className={styles.focusMeta}>
                  {nodeKindLabel(selectedNode.kind)} · {selectedConnections.length} connections
                </p>
                <div className={styles.pillRow}>
                  {selectedConnections.slice(0, 6).map((item) => (
                    <span key={item.id} className={styles.pill}>
                      {truncate(item.label, 16)}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className={styles.mutedText}>Select a node to inspect connected memory context.</p>
            )}
          </article>

          <article className={styles.sideCard}>
            <p className={styles.cardKicker}>Edge Mix</p>
            <div className={styles.metricList}>
              <div className={styles.metricRow}>
                <span>Relations</span>
                <strong>{edgeCountByKind.relation}</strong>
              </div>
              <div className={styles.metricRow}>
                <span>Mentions</span>
                <strong>{edgeCountByKind.mention}</strong>
              </div>
              <div className={styles.metricRow}>
                <span>Platform Links</span>
                <strong>{edgeCountByKind.platform}</strong>
              </div>
            </div>
          </article>

          <article className={styles.sideCard}>
            <p className={styles.cardKicker}>Insight Snapshot</p>
            <div className={styles.metricList}>
              <div className={styles.metricRow}>
                <span>Contradictions</span>
                <strong>{insights?.summary.contradictionCount ?? 0}</strong>
              </div>
              <div className={styles.metricRow}>
                <span>Stale Decisions</span>
                <strong>{insights?.summary.staleDecisionCount ?? 0}</strong>
              </div>
              <div className={styles.metricRow}>
                <span>High Impact</span>
                <strong>{insights?.summary.highImpactCount ?? 0}</strong>
              </div>
              <div className={styles.metricRow}>
                <span>Uncertain</span>
                <strong>{insights?.summary.uncertainRelationCount ?? 0}</strong>
              </div>
            </div>
            {insights?.generatedAt ? (
              <p className={styles.generatedAt}>
                Updated {new Date(insights.generatedAt).toLocaleString()}
              </p>
            ) : null}
          </article>
        </aside>
      </section>

      <section className={styles.listGrid}>
        <article className={styles.listCard}>
          <h3 className={styles.listTitle}>Top Entities</h3>
          <div className={styles.listBody}>
            {(payload.panels.topEntities ?? []).slice(0, 8).map((item) => (
              <p key={item.label} className={styles.listLine}>
                <span>{truncate(item.label, 32)}</span>
                <strong>{item.mentions}</strong>
              </p>
            ))}
            {payload.panels.topEntities.length === 0 ? (
              <p className={styles.mutedText}>No entities extracted yet.</p>
            ) : null}
          </div>
        </article>

        <article className={styles.listCard}>
          <h3 className={styles.listTitle}>Strongest Relations</h3>
          <div className={styles.listBody}>
            {(payload.panels.strongestRelations ?? []).slice(0, 8).map((item, index) => (
              <p key={`${item.source}-${item.target}-${index}`} className={styles.listLineDense}>
                {truncate(item.source, 20)} <span className={styles.linkType}>{item.relationType}</span>{" "}
                {truncate(item.target, 20)}
              </p>
            ))}
            {payload.panels.strongestRelations.length === 0 ? (
              <p className={styles.mutedText}>No relations available yet.</p>
            ) : null}
          </div>
        </article>
      </section>

      <section className={styles.listGrid}>
        <article className={styles.listCard}>
          <h3 className={styles.listTitle}>Contradictory Signals</h3>
          <div className={styles.listBody}>
            {(insights?.contradictions ?? []).slice(0, 6).map((item, idx) => (
              <p key={`${item.source}-${item.relationType}-${idx}`} className={styles.listLineDense}>
                {truncate(item.source, 20)} {item.relationType}{" "}
                <span className={styles.linkType}>
                  {truncate(item.targets.map((target) => target.label).join(" / "), 34)}
                </span>
              </p>
            ))}
            {(insights?.contradictions ?? []).length === 0 ? (
              <p className={styles.mutedText}>No contradiction patterns detected.</p>
            ) : null}
          </div>
        </article>

        <article className={styles.listCard}>
          <h3 className={styles.listTitle}>Stale Decisions</h3>
          <div className={styles.listBody}>
            {(insights?.staleDecisions ?? []).slice(0, 6).map((item, idx) => (
              <p key={`${item.source}-${item.target}-${idx}`} className={styles.listLineDense}>
                {truncate(item.source, 18)} {item.relationType} {truncate(item.target, 18)}{" "}
                <strong className={styles.daysOld}>{item.daysSinceSeen}d</strong>
              </p>
            ))}
            {(insights?.staleDecisions ?? []).length === 0 ? (
              <p className={styles.mutedText}>No stale decisions detected.</p>
            ) : null}
          </div>
        </article>
      </section>

      <section className={styles.recoCard}>
        <h3 className={styles.listTitle}>Insight Recommendations</h3>
        <div className={styles.listBody}>
          {(insights?.recommendations ?? []).slice(0, 6).map((item, idx) => (
            <p key={`${item}-${idx}`} className={styles.listLineDense}>
              • {item}
            </p>
          ))}
          {(insights?.recommendations ?? []).length === 0 ? (
            <p className={styles.mutedText}>No recommendations yet. Save more memories to enrich the graph.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

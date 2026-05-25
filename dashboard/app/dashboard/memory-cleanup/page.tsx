"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  GitMerge,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MemoryItem = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type CleanupProposal = {
  id: string;
  proposalType: "bucket" | "keep" | "promote" | "merge" | "rewrite" | "prune";
  status: "proposed" | "contested" | "approved" | "rejected" | "applied" | "failed";
  sourceMemoryIds: string[];
  targetMemoryId: string | null;
  proposedContent: string | null;
  rationale: string;
  riskLevel: "low" | "medium" | "high";
  confidence: number;
  bucket: CleanupBucket | null;
  bucketReason: string | null;
  bucketConfidence: number | null;
  trace?: {
    consolidator?: unknown;
    adversary?: unknown;
    debate?: unknown;
    judge?: unknown;
    apply?: unknown;
  };
};

type CleanupRun = {
  id: string;
  status: "running" | "completed" | "failed";
  runReason: "daily_intelligence" | "manual";
  dryRun: boolean;
  summary: {
    proposed: number;
    contested: number;
    approved: number;
    rejected: number;
    applied: number;
    failed: number;
    kept: number;
    bucketed: number;
    shortTerm: number;
    longTerm: number;
    permanent: number;
    promoted: number;
    merged: number;
    rewritten: number;
    pruned: number;
    durationMs?: number;
    aiCalls?: number;
    usage?: {
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedPromptTokens: number;
      estimatedCompletionTokens: number;
      estimatedTotalTokens: number;
      estimatedCostUsd: number;
      models: Record<string, number>;
    };
    selectedMemories?: number;
    batches?: number;
    remainingUnreviewed?: number;
    skipped?: boolean;
    skipReason?: string;
  };
  proposals: CleanupProposal[];
};

type CleanupBucket = "short_term" | "long_term" | "permanent";
type DisplayBucket = CleanupBucket | "unbucketed";

type MemoriesPayload = {
  memories?: MemoryItem[];
  pagination?: { total?: number; hasMore?: boolean; nextOffset?: number | null };
  error?: string;
};

type RunsPayload = {
  runs?: CleanupRun[];
  error?: string;
};

type RunPayload = {
  run?: CleanupRun;
  adminEmail?: {
    sent: boolean;
    skipped: boolean;
    to: string | null;
    error?: string;
  };
  error?: string;
};

type LoopMinerUsage = CleanupRun["summary"]["usage"];

type LoopMinerEpisode = {
  id: string;
  intent: string;
  sources: string[];
  outputType: string;
  toolNames: string[];
  steps: string[];
  approved: boolean;
  sealedAt: string;
  turnCount: number;
};

type LoopMinerSuggestion = {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  confidence: number;
  fingerprint: string;
  triggerCount: number;
  createdAt: string;
  metadata: unknown;
};

type LoopMinerRun = {
  id: string;
  status: "running" | "completed" | "failed";
  summary: {
    episodesBuilt: number;
    loopsDetected: number;
    loopsQualified: number;
    suggestionsCreated: number;
    durationMs: number;
    aiCalls: number;
    usage: LoopMinerUsage;
    warnings?: string[];
    skipped?: boolean;
    skipReason?: string;
    patternTrace?: {
      candidateGroups: Array<{
        id: string;
        title: string;
        episodeIds: string[];
        sharedJob: string;
        sharedArtifact: string;
        sharedActions: string[];
        confidence: number;
        generationReason: string;
      }>;
      approvedGroups: string[];
      rejectedGroups: Array<{
        candidateGroupId: string;
        status: string;
        rationale: string;
      }>;
      adversaryFindings: Array<{
        candidateGroupId: string;
        contested: boolean;
        critique: string;
        recommendedAction: string;
      }>;
      judgeDecisions: Array<{
        candidateGroupId: string;
        status: string;
        confidence: number;
        rationale: string;
      }>;
    };
    phaseUsage?: {
      episodeBuilder?: {
        calls: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedTotalTokens: number;
        estimatedCostUsd: number;
        batchesProcessed: number;
        batchesSkipped: number;
        inputEvents: number;
        outputEpisodes: number;
        tokensPerInputEvent: number;
        tokensPerOutputEpisode: number;
        costPerOutputEpisodeUsd: number;
        maxEstimatedPromptTokensPerCall: number;
      };
      loopDetector?: {
        calls: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedTotalTokens: number;
        estimatedCostUsd: number;
        batchesProcessed: number;
        batchesSkipped: number;
        inputEpisodes?: number;
        outputEpisodes?: number;
        loopsInput?: number;
        loopsOutput?: number;
      };
      loopEvaluator?: {
        calls: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedTotalTokens: number;
        estimatedCostUsd: number;
        batchesProcessed: number;
        batchesSkipped: number;
        loopsInput?: number;
        loopsOutput?: number;
      };
      dnaGenerator?: {
        calls: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedTotalTokens: number;
        estimatedCostUsd: number;
        batchesProcessed: number;
        batchesSkipped: number;
        loopsInput?: number;
        loopsOutput?: number;
      };
    };
    debugTrace?: {
      phaseTimings?: Array<{
        phase: string;
        startedAt: string;
        endedAt?: string;
        durationMs?: number;
        status: "running" | "completed" | "failed" | "skipped";
        details?: Record<string, unknown>;
      }>;
      totalElapsedMs?: number;
    };
  };
  error?: unknown;
  createdAt: string;
  completedAt: string | null;
  episodes: LoopMinerEpisode[];
  suggestions: LoopMinerSuggestion[];
};

type LoopMinerRunsPayload = {
  runs?: LoopMinerRun[];
  error?: string;
};

type LoopMinerRunPayload = {
  run?: LoopMinerRun | null;
  queued?: boolean;
  message?: string;
  error?: string;
};

type LoopMinerEmbeddingPoint = {
  episodeId: string;
  intent: string;
  outputType: string;
  sealedAt: string;
  turnCount: number;
  sources: string[];
  embeddingStatus?: "pending" | "ready" | "failed";
  x: number;
  y: number;
};

type LoopMinerEmbeddingMap = {
  runId: string;
  points: LoopMinerEmbeddingPoint[];
  meta: {
    totalEpisodes: number;
    mappedEpisodes: number;
    missingEpisodeIds: string[];
    vectorStoreEnabled: boolean;
    reason?: string;
  };
};

type LoopMinerEmbeddingMapPayload = {
  map?: LoopMinerEmbeddingMap;
  error?: string;
};

type LoopMinerPhaseTiming = {
  phase: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "skipped";
  details?: Record<string, unknown>;
};

type LoopMinerRunStatus = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  episodesBuilt: number;
  loopsDetected: number;
  loopsQualified: number;
  suggestionsCreated: number;
  currentPhase: string | null;
  memoryCount: number;
  liveProgress: { phaseTimings: LoopMinerPhaseTiming[]; totalElapsedMs: number } | null;
  warnings: string[];
};

const PAGE_SIZE = 200;
const LOOP_MINER_STALE_MS = 60 * 60 * 1000;
const BUCKETS: Array<{ id: DisplayBucket; title: string; caption: string; className: string; labelClassName: string }> = [
  {
    id: "unbucketed",
    title: "Unbucketed memories",
    caption: "ready for cleanup",
    className: "border-slate-200 bg-slate-50",
    labelClassName: "border-slate-200 bg-white text-slate-700",
  },
  {
    id: "short_term",
    title: "Short term memories",
    caption: "decays fast",
    className: "border-sky-200 bg-sky-50/70",
    labelClassName: "border-sky-200 bg-sky-100 text-sky-800",
  },
  {
    id: "long_term",
    title: "Long term memories",
    caption: "decays slow",
    className: "border-indigo-200 bg-indigo-50/70",
    labelClassName: "border-indigo-200 bg-indigo-100 text-indigo-800",
  },
  {
    id: "permanent",
    title: "Permanent memories",
    caption: "never decays",
    className: "border-pink-200 bg-pink-50/80",
    labelClassName: "border-pink-200 bg-pink-100 text-pink-800",
  },
];

function memoryType(memory: MemoryItem): string {
  const value = memory.metadata?.memory_type;
  return typeof value === "string" ? value : "unknown";
}

function category(memory: MemoryItem): string {
  const value = memory.metadata?.category;
  return typeof value === "string" && value.trim() ? value : "uncategorized";
}

function platform(memory: MemoryItem): string {
  const value = memory.metadata?.platform;
  return typeof value === "string" && value.trim() ? value : "other";
}

function isCleanupBucket(value: unknown): value is CleanupBucket {
  return value === "short_term" || value === "long_term" || value === "permanent";
}

function persistedBucket(memory: MemoryItem): DisplayBucket {
  const persisted = memory.metadata?.cleanup_bucket;
  if (isCleanupBucket(persisted)) return persisted;
  return "unbucketed";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString();
}

function pillClass(value: string): string {
  if (value === "applied" || value === "completed" || value === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "failed" || value === "rejected") return "border-rose-200 bg-rose-50 text-rose-700";
  if (value === "contested" || value === "high") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function formatCost(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(6)}`;
}

function formatDuration(value: number | undefined): string {
  const ms = value ?? 0;
  if (ms <= 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function suggestionDna(suggestion: LoopMinerSuggestion): Record<string, unknown> {
  return readRecord(readRecord(suggestion.metadata).dna);
}

function phaseIcon(status: CleanupProposal["status"]) {
  if (status === "applied" || status === "approved") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed" || status === "rejected") return <XCircle className="h-4 w-4" />;
  return <GitMerge className="h-4 w-4" />;
}

const EMBEDDING_MAP_COLORS = [
  "#2563eb",
  "#0d9488",
  "#c2410c",
  "#be123c",
  "#7c3aed",
  "#4d7c0f",
  "#0369a1",
  "#b45309",
];

function outputTypeColor(outputType: string): string {
  let hash = 0;
  for (let index = 0; index < outputType.length; index += 1) {
    hash = ((hash << 5) - hash + outputType.charCodeAt(index)) | 0;
  }
  return EMBEDDING_MAP_COLORS[Math.abs(hash) % EMBEDDING_MAP_COLORS.length] ?? EMBEDDING_MAP_COLORS[0];
}

const LOOP_MINER_PHASE_LABELS: Record<string, string> = {
  memory_ingest: "Reading memories",
  loop_detector: "Detecting loops",
  episode_builder: "Building loop episodes",
  loop_evaluator: "Evaluating loops",
  implementability_filter: "Checking integrations",
  dna_generator: "Generating workflow DNA",
  persist_suggestions: "Saving suggestions",
};

function loopMinerPhaseLabel(phase: string): string {
  return LOOP_MINER_PHASE_LABELS[phase] ?? phase.replace(/_/g, " ");
}

export default function MemoryCleanupPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [runs, setRuns] = useState<CleanupRun[]>([]);
  const [loopMinerRuns, setLoopMinerRuns] = useState<LoopMinerRun[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedTraceIds, setExpandedTraceIds] = useState<Set<string>>(new Set());
  const [activeRun, setActiveRun] = useState<CleanupRun | null>(null);
  const [activeLoopMinerRun, setActiveLoopMinerRun] = useState<LoopMinerRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningMode, setRunningMode] = useState<"dry" | "apply" | null>(null);
  const [loopMinerRunning, setLoopMinerRunning] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [adminEmailStatus, setAdminEmailStatus] = useState<RunPayload["adminEmail"] | null>(null);
  const [loopMinerNotice, setLoopMinerNotice] = useState<string | null>(null);
  const [loopMinerEmbeddingMaps, setLoopMinerEmbeddingMaps] = useState<Record<string, LoopMinerEmbeddingMap>>({});
  const [loopMinerEmbeddingLoadingForRunId, setLoopMinerEmbeddingLoadingForRunId] = useState<string | null>(null);
  const [loopMinerEmbeddingErrorByRunId, setLoopMinerEmbeddingErrorByRunId] = useState<Record<string, string>>({});
  const [liveRunStatus, setLiveRunStatus] = useState<LoopMinerRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loopMinerStatusStreamRef = useRef<EventSource | null>(null);
  const loopMinerEmbeddingFetchRef = useRef<Set<string>>(new Set());
  const loopMinerEmbeddingLoadedRef = useRef<Set<string>>(new Set());

  const selectedCount = selectedIds.size;
  const sortedMemories = useMemo(
    () => [...memories].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    [memories]
  );
  const bucketProposalByMemoryId = useMemo(() => {
    const map = new Map<string, CleanupProposal>();
    for (const proposal of activeRun?.proposals ?? []) {
      if (proposal.proposalType !== "bucket" || !proposal.bucket) continue;
      const memoryId = proposal.sourceMemoryIds[0];
      if (memoryId) map.set(memoryId, proposal);
    }
    return map;
  }, [activeRun]);
  const memoriesByBucket = useMemo(() => {
    const grouped: Record<DisplayBucket, MemoryItem[]> = {
      unbucketed: [],
      short_term: [],
      long_term: [],
      permanent: [],
    };
    for (const memory of sortedMemories) {
      const proposalBucket = bucketProposalByMemoryId.get(memory.id)?.bucket;
      grouped[proposalBucket ?? persistedBucket(memory)].push(memory);
    }
    return grouped;
  }, [bucketProposalByMemoryId, sortedMemories]);

  const latestLoopMinerRun = activeLoopMinerRun ?? loopMinerRuns[0] ?? null;
  const loopMinerRunAgeMs = latestLoopMinerRun ? Date.now() - Date.parse(latestLoopMinerRun.createdAt) : 0;
  const loopMinerRunStale = latestLoopMinerRun?.status === "running" && Number.isFinite(loopMinerRunAgeMs) && loopMinerRunAgeMs > LOOP_MINER_STALE_MS;
  const loopMinerInProgress = latestLoopMinerRun?.status === "running" && !loopMinerRunStale;
  const latestLoopEmbeddingMap = latestLoopMinerRun ? loopMinerEmbeddingMaps[latestLoopMinerRun.id] ?? null : null;
  const latestLoopEmbeddingError = latestLoopMinerRun ? loopMinerEmbeddingErrorByRunId[latestLoopMinerRun.id] ?? null : null;
  const latestLoopEmbeddingLoading = latestLoopMinerRun ? loopMinerEmbeddingLoadingForRunId === latestLoopMinerRun.id : false;

  const fetchMemories = useCallback(async () => {
    const nextMemories: MemoryItem[] = [];
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      const response = await fetch(`/api/memories?${query.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as MemoriesPayload;
      if (!response.ok) throw new Error(payload.error ?? "Failed to load memories");
      nextMemories.push(...(Array.isArray(payload.memories) ? payload.memories : []));
      if (!payload.pagination?.hasMore || payload.pagination.nextOffset == null) break;
      offset = payload.pagination.nextOffset;
    }
    setMemories(nextMemories);
  }, []);

  const fetchRuns = useCallback(async (options: { activateLatest?: boolean } = {}) => {
    const activateLatest = options.activateLatest ?? true;
    const response = await fetch("/api/memories/cleanup/runs", { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as RunsPayload;
    if (!response.ok) throw new Error(payload.error ?? "Failed to load cleanup runs");
    const nextRuns = Array.isArray(payload.runs) ? payload.runs : [];
    setRuns(nextRuns);
    if (activateLatest) {
      setActiveRun((current) => current ?? nextRuns[0] ?? null);
    }
  }, []);

  const fetchLoopMinerRuns = useCallback(async (options: { activateLatest?: boolean } = {}) => {
    const activateLatest = options.activateLatest ?? true;
    const response = await fetch("/api/memories/cleanup/loop-miner/runs", { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as LoopMinerRunsPayload;
    if (!response.ok) throw new Error(payload.error ?? "Failed to load loop miner runs");
    const nextRuns = Array.isArray(payload.runs) ? payload.runs : [];
    setLoopMinerRuns(nextRuns);
    if (activateLatest) {
      setActiveLoopMinerRun(nextRuns[0] ?? null);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchMemories(), fetchRuns(), fetchLoopMinerRuns()]);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh cleanup view");
    } finally {
      setLoading(false);
    }
  }, [fetchLoopMinerRuns, fetchMemories, fetchRuns]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const runId = latestLoopMinerRun?.id;
    if (!runId) return;
    if (loopMinerEmbeddingLoadedRef.current.has(runId)) return;
    if (loopMinerEmbeddingMaps[runId]) {
      loopMinerEmbeddingLoadedRef.current.add(runId);
      return;
    }
    if (loopMinerEmbeddingFetchRef.current.has(runId)) return;

    loopMinerEmbeddingFetchRef.current.add(runId);
    let cancelled = false;
    setLoopMinerEmbeddingLoadingForRunId(runId);
    setLoopMinerEmbeddingErrorByRunId((current) => {
      if (!current[runId]) return current;
      const next = { ...current };
      delete next[runId];
      return next;
    });

    void (async () => {
      try {
        const response = await fetch(`/api/memories/cleanup/loop-miner/runs/${runId}/embedding-map`, { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as LoopMinerEmbeddingMapPayload;
        if (!response.ok || !payload.map) throw new Error(payload.error ?? "Failed to load loop miner embedding map");
        if (cancelled) return;
        loopMinerEmbeddingLoadedRef.current.add(runId);
        setLoopMinerEmbeddingMaps((current) => ({ ...current, [runId]: payload.map! }));
      } catch (mapError) {
        if (cancelled) return;
        const message = mapError instanceof Error ? mapError.message : "Failed to load loop miner embedding map";
        setLoopMinerEmbeddingErrorByRunId((current) => ({ ...current, [runId]: message }));
      } finally {
        loopMinerEmbeddingFetchRef.current.delete(runId);
        if (!cancelled) {
          setLoopMinerEmbeddingLoadingForRunId((current) => (current === runId ? null : current));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [latestLoopMinerRun?.id, loopMinerEmbeddingMaps]);

  // Stream live progress while a run is active
  useEffect(() => {
    const runId = latestLoopMinerRun?.id;
    if (!loopMinerInProgress || !runId) {
      if (loopMinerStatusStreamRef.current) {
        loopMinerStatusStreamRef.current.close();
        loopMinerStatusStreamRef.current = null;
      }
      setLiveRunStatus(null);
      return;
    }

    if (loopMinerStatusStreamRef.current) return;

    const stream = new EventSource(`/api/memories/cleanup/loop-miner/runs/${runId}/status/stream`);
    loopMinerStatusStreamRef.current = stream;

    stream.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as LoopMinerRunStatus;
        setLiveRunStatus(data);
        if (data.status !== "running") {
          stream.close();
          loopMinerStatusStreamRef.current = null;
          void fetchLoopMinerRuns({ activateLatest: true });
        }
      } catch {
        // ignore malformed events
      }
    };

    stream.onerror = () => {
      stream.close();
      loopMinerStatusStreamRef.current = null;
    };

    return () => {
      stream.close();
      loopMinerStatusStreamRef.current = null;
    };
  }, [loopMinerInProgress, latestLoopMinerRun?.id, fetchLoopMinerRuns]);

  const runCleanup = useCallback(async (dryRun: boolean) => {
    setRunningMode(dryRun ? "dry" : "apply");
    setError(null);
    setAdminEmailStatus(null);
    try {
      const response = await fetch("/api/memories/cleanup/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          processAll: true,
          includeReviewed: false,
          selectionStrategy: "newest_hybrid",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as RunPayload;
      if (!response.ok || !payload.run) throw new Error(payload.error ?? "Failed to run cleanup");
      setActiveRun(payload.run);
      setAdminEmailStatus(payload.adminEmail ?? null);
      await Promise.all([fetchMemories(), fetchRuns(), fetchLoopMinerRuns()]);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run cleanup");
    } finally {
      setRunningMode(null);
    }
  }, [fetchLoopMinerRuns, fetchMemories, fetchRuns]);

  const runLoopMiner = useCallback(async () => {
    setLoopMinerRunning(true);
    setError(null);
    setLoopMinerNotice(null);
    setLiveRunStatus(null);
    try {
      const response = await fetch("/api/memories/cleanup/loop-miner/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookbackDays: 30, processAll: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as LoopMinerRunPayload;
      if (!response.ok || !payload.run) throw new Error(payload.error ?? "Failed to run Loop Miner");
      setActiveLoopMinerRun(payload.run);
      if (payload.message) setLoopMinerNotice(payload.message);
      await fetchLoopMinerRuns({ activateLatest: true });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run Loop Miner");
    } finally {
      setLoopMinerRunning(false);
    }
  }, [fetchLoopMinerRuns]);

  const resetCleanupFlags = useCallback(async () => {
    setError(null);
    setAdminEmailStatus(null);
    try {
      const response = await fetch("/api/memories/cleanup/reset", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Failed to reset cleanup flags");
      setActiveRun(null);
      await Promise.all([fetchMemories(), fetchRuns({ activateLatest: false }), fetchLoopMinerRuns({ activateLatest: false })]);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Failed to reset cleanup flags");
    }
  }, [fetchLoopMinerRuns, fetchMemories, fetchRuns]);

  const deleteMemory = useCallback(async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to delete memory");
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await fetchMemories();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete memory");
    } finally {
      setDeletingId(null);
    }
  }, [fetchMemories]);

  const deleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    setError(null);
    try {
      for (const id of ids) {
        const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`Failed to delete ${id}`);
      }
      setSelectedIds(new Set());
      await fetchMemories();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete selected memories");
    } finally {
      setBulkDeleting(false);
    }
  }, [fetchMemories, selectedIds]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleTrace = useCallback((id: string) => {
    setExpandedTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-6 py-5">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-slate-700" />
              <h1 className="text-xl font-semibold text-slate-900">Memory Cleanup Lab</h1>
            </div>
            <p className="mt-1 text-sm text-slate-500">Temporary view for running adversarial cleanup and inspecting the result.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={refreshAll} disabled={loading || Boolean(runningMode)}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            <Button type="button" variant="outline" onClick={runLoopMiner} disabled={loopMinerRunning || loopMinerInProgress || Boolean(runningMode)}>
              {loopMinerRunning || loopMinerInProgress ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Workflow className="mr-1.5 h-4 w-4" />}
              Run Loop Miner
            </Button>
            <Button type="button" variant="outline" onClick={resetCleanupFlags} disabled={Boolean(runningMode)}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Reset flags
            </Button>
            <Button type="button" variant="outline" onClick={() => runCleanup(true)} disabled={Boolean(runningMode)}>
              {runningMode === "dry" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
              Preview cleanup
            </Button>
            <Button type="button" className="bg-slate-900 text-white hover:bg-slate-800" onClick={() => runCleanup(false)} disabled={Boolean(runningMode)}>
              {runningMode === "apply" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Run cleanup
            </Button>
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-7xl gap-4 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          {error ? (
            <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : null}
          {loopMinerNotice ? (
            <div className="border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">{loopMinerNotice}</div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-4">
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Memories</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{memories.length}</div>
              </CardContent>
            </Card>
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Proposed</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{activeRun?.summary.proposed ?? 0}</div>
              </CardContent>
            </Card>
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Applied</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700">{activeRun?.summary.applied ?? 0}</div>
              </CardContent>
            </Card>
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Contested</div>
                <div className="mt-1 text-2xl font-semibold text-amber-700">{activeRun?.summary.contested ?? 0}</div>
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-900">Memory buckets</div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{selectedCount} selected</span>
              <Button type="button" variant="outline" size="sm" onClick={deleteSelected} disabled={selectedCount === 0 || bulkDeleting}>
                {bulkDeleting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                Delete selected
              </Button>
            </div>
          </div>

          {loading ? (
            <Card className="border-slate-200">
              <CardContent className="flex h-48 items-center justify-center p-0 text-sm text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading memories
              </CardContent>
            </Card>
          ) : sortedMemories.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="px-4 py-10 text-center text-sm text-slate-500">No memories available for cleanup.</CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-4">
              {BUCKETS.map((bucket) => (
                <Card key={bucket.id} className={`overflow-hidden ${bucket.className}`}>
                  <CardHeader className="border-b border-white/70 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className={`border px-2 py-0.5 text-xs font-semibold ${bucket.labelClassName}`}>{bucket.title}</span>
                        <div className="mt-2 text-xs text-slate-500">{bucket.caption}</div>
                      </div>
                      <div className="text-2xl font-semibold text-slate-900">{memoriesByBucket[bucket.id].length}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="max-h-[720px] space-y-3 overflow-auto p-3">
                    {memoriesByBucket[bucket.id].length === 0 ? (
                      <div className="border border-dashed border-slate-300 bg-white/60 px-3 py-8 text-center text-xs text-slate-500">No memories in this bucket.</div>
                    ) : (
                      memoriesByBucket[bucket.id].map((memory) => {
                        const bucketProposal = bucketProposalByMemoryId.get(memory.id);
                        return (
                          <div key={memory.id} className="border border-white bg-white p-3 shadow-sm">
                            <div className="flex items-start justify-between gap-2">
                              <input
                                aria-label={`Select memory ${memory.id}`}
                                type="checkbox"
                                className="mt-1 h-4 w-4 rounded border-slate-300"
                                checked={selectedIds.has(memory.id)}
                                onChange={() => toggleSelected(memory.id)}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                onClick={() => deleteMemory(memory.id)}
                                disabled={deletingId === memory.id}
                              >
                                {deletingId === memory.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">{memoryType(memory)}</span>
                              <span className="border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">{platform(memory)}</span>
                              <span className="text-[11px] text-slate-400">{category(memory)}</span>
                              {bucketProposal ? (
                                <span className="border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{Math.round((bucketProposal.bucketConfidence ?? bucketProposal.confidence) * 100)}%</span>
                              ) : null}
                            </div>
                            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{memory.text}</p>
                            <p className="mt-2 text-xs leading-5 text-slate-500">{bucketProposal?.bucketReason ?? String(memory.metadata?.cleanup_bucket_reason ?? "Classified from memory type.")}</p>
                            <p className="mt-2 font-mono text-[11px] text-slate-400">{memory.id}</p>
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 px-4 py-3">
              <CardTitle className="text-sm font-semibold text-slate-900">Latest Run</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              {!activeRun ? (
                <div className="text-sm text-slate-500">Run a cleanup preview to see the pipeline.</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`border px-2 py-0.5 text-xs font-medium ${pillClass(activeRun.status)}`}>{activeRun.status}</span>
                    <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{activeRun.dryRun ? "dry run" : "applied"}</span>
                    <span className="text-xs text-slate-400">{activeRun.summary.durationMs ?? 0}ms</span>
                    <span className="text-xs text-slate-400">{activeRun.summary.batches ?? 0} batches</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="border border-slate-200 bg-white p-2">
                      <div className="text-lg font-semibold text-slate-900">{activeRun.summary.selectedMemories ?? 0}</div>
                      <div className="text-[11px] text-slate-500">reviewed</div>
                    </div>
                    <div className="border border-slate-200 bg-white p-2">
                      <div className="text-lg font-semibold text-slate-900">{activeRun.summary.remainingUnreviewed ?? 0}</div>
                      <div className="text-[11px] text-slate-500">unreviewed</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ["bucket", activeRun.summary.bucketed],
                      ["short", activeRun.summary.shortTerm],
                      ["long", activeRun.summary.longTerm],
                      ["perm", activeRun.summary.permanent],
                      ["promote", activeRun.summary.promoted],
                      ["merge", activeRun.summary.merged],
                      ["prune", activeRun.summary.pruned],
                      ["rewrite", activeRun.summary.rewritten],
                      ["failed", activeRun.summary.failed],
                    ].map(([label, value]) => (
                      <div key={label} className="border border-slate-200 bg-white p-2">
                        <div className="text-lg font-semibold text-slate-900">{value}</div>
                        <div className="text-[11px] text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Usage</div>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      {[
                        ["ai calls", activeRun.summary.usage?.calls ?? activeRun.summary.aiCalls ?? 0],
                        ["cost", formatCost(activeRun.summary.usage?.estimatedCostUsd)],
                        ["tokens", activeRun.summary.usage?.totalTokens ?? 0],
                        ["est tokens", activeRun.summary.usage?.estimatedTotalTokens ?? 0],
                      ].map(([label, value]) => (
                        <div key={label} className="border border-slate-200 bg-white p-2">
                          <div className="text-sm font-semibold text-slate-900">{value}</div>
                          <div className="text-[11px] text-slate-500">{label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                      <div>Prompt: {activeRun.summary.usage?.promptTokens ?? 0} provider / {activeRun.summary.usage?.estimatedPromptTokens ?? 0} estimated</div>
                      <div>Completion: {activeRun.summary.usage?.completionTokens ?? 0} provider / {activeRun.summary.usage?.estimatedCompletionTokens ?? 0} estimated</div>
                      <div>Models: {Object.entries(activeRun.summary.usage?.models ?? {}).map(([model, count]) => `${model} x${count}`).join(", ") || "none"}</div>
                    </div>
                  </div>
                  {adminEmailStatus ? (
                    <div className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                      <div className="font-semibold text-slate-800">Admin email</div>
                      <div>Status: {adminEmailStatus.sent ? "sent" : adminEmailStatus.skipped ? "skipped" : "failed"}</div>
                      <div>To: {adminEmailStatus.to ?? "none"}</div>
                      {adminEmailStatus.error ? <div className="text-rose-600">Error: {adminEmailStatus.error}</div> : null}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Phase Trace</div>
                    {["snapshot", "consolidator", "adversary", "debate", "judge", "apply"].map((phase, index) => (
                      <div key={phase} className="flex items-center gap-2 text-sm">
                        <span className="flex h-5 w-5 items-center justify-center border border-slate-200 bg-slate-50 text-[11px] text-slate-600">{index + 1}</span>
                        <span className="capitalize text-slate-700">{phase}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Workflow className="h-4 w-4 text-slate-600" />
                  Loop Miner
                </CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={runLoopMiner} disabled={loopMinerRunning || loopMinerInProgress || Boolean(runningMode)}>
                  {loopMinerRunning || loopMinerInProgress ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  Run
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              {!latestLoopMinerRun ? (
                <div className="text-sm text-slate-500">No Loop Miner runs yet. The nightly daily intelligence pass will populate this view.</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`border px-2 py-0.5 text-xs font-medium ${pillClass(latestLoopMinerRun.status)}`}>{latestLoopMinerRun.status}</span>
                    <span className="text-xs text-slate-400">{dateLabel(latestLoopMinerRun.createdAt)}</span>
                    <span className="text-xs text-slate-400">{latestLoopMinerRun.summary.durationMs ?? 0}ms</span>
                    {loopMinerRunStale ? (
                      <span className="border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">stale run recovered on next refresh</span>
                    ) : null}
                    {latestLoopMinerRun.summary.skipped ? (
                      <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{latestLoopMinerRun.summary.skipReason ?? "skipped"}</span>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      ["episodes", latestLoopMinerRun.summary.episodesBuilt],
                      ["loops", latestLoopMinerRun.summary.loopsDetected ?? latestLoopMinerRun.summary.patternTrace?.approvedGroups.length ?? 0],
                      ["qualified", latestLoopMinerRun.summary.loopsQualified],
                      ["suggestions", latestLoopMinerRun.summary.suggestionsCreated],
                    ].map(([label, value]) => (
                      <div key={label} className="border border-slate-200 bg-white p-2">
                        <div className="text-lg font-semibold text-slate-900">{value}</div>
                        <div className="text-[11px] text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-center">
                    {[
                      ["ai calls", latestLoopMinerRun.summary.usage?.calls ?? latestLoopMinerRun.summary.aiCalls ?? 0],
                      ["cost", formatCost(latestLoopMinerRun.summary.usage?.estimatedCostUsd)],
                      ["tokens", latestLoopMinerRun.summary.usage?.totalTokens ?? 0],
                      ["est tokens", latestLoopMinerRun.summary.usage?.estimatedTotalTokens ?? 0],
                    ].map(([label, value]) => (
                      <div key={label} className="border border-slate-200 bg-white p-2">
                        <div className="text-sm font-semibold text-slate-900">{value}</div>
                        <div className="text-[11px] text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                    <div>Prompt: {latestLoopMinerRun.summary.usage?.promptTokens ?? 0} provider / {latestLoopMinerRun.summary.usage?.estimatedPromptTokens ?? 0} estimated</div>
                    <div>Completion: {latestLoopMinerRun.summary.usage?.completionTokens ?? 0} provider / {latestLoopMinerRun.summary.usage?.estimatedCompletionTokens ?? 0} estimated</div>
                    <div>Models: {Object.entries(latestLoopMinerRun.summary.usage?.models ?? {}).map(([model, count]) => `${model} x${count}`).join(", ") || "none"}</div>
                  </div>

                  {latestLoopMinerRun.summary.phaseUsage ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Phase Efficiency</div>
                      {latestLoopMinerRun.summary.phaseUsage.episodeBuilder ? (
                        <div className="grid grid-cols-2 gap-2 text-center">
                          {[
                            ["events", latestLoopMinerRun.summary.phaseUsage.episodeBuilder.inputEvents],
                            ["episodes", latestLoopMinerRun.summary.phaseUsage.episodeBuilder.outputEpisodes],
                            ["tok/event", latestLoopMinerRun.summary.phaseUsage.episodeBuilder.tokensPerInputEvent],
                            ["tok/episode", latestLoopMinerRun.summary.phaseUsage.episodeBuilder.tokensPerOutputEpisode],
                            ["cost/episode", formatCost(latestLoopMinerRun.summary.phaseUsage.episodeBuilder.costPerOutputEpisodeUsd)],
                            ["max prompt tok", latestLoopMinerRun.summary.phaseUsage.episodeBuilder.maxEstimatedPromptTokensPerCall],
                          ].map(([label, value]) => (
                            <div key={label} className="border border-slate-200 bg-white p-2">
                              <div className="text-sm font-semibold text-slate-900">{value}</div>
                              <div className="text-[11px] text-slate-500">{label}</div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="space-y-1">
                        {[
                          { label: "episodeBuilder", phase: latestLoopMinerRun.summary.phaseUsage.episodeBuilder },
                          { label: "loopDetector", phase: latestLoopMinerRun.summary.phaseUsage.loopDetector },
                          { label: "loopEvaluator", phase: latestLoopMinerRun.summary.phaseUsage.loopEvaluator },
                          { label: "dnaGenerator", phase: latestLoopMinerRun.summary.phaseUsage.dnaGenerator },
                        ].map(({ label, phase }) => {
                          if (!phase) return null;
                          return (
                            <div key={label} className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                              <div className="font-semibold text-slate-800">{label}</div>
                              <div>calls {phase.calls} | batches {phase.batchesProcessed} (skipped {phase.batchesSkipped})</div>
                              <div>tokens provider {phase.totalTokens} | estimated {phase.estimatedTotalTokens}</div>
                              <div>cost {formatCost(phase.estimatedCostUsd)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {(() => {
                    const livePhases = loopMinerInProgress ? (liveRunStatus?.liveProgress?.phaseTimings ?? null) : null;
                    const finalPhases = latestLoopMinerRun.summary.debugTrace?.phaseTimings ?? null;
                    const phases = livePhases ?? finalPhases;
                    const totalElapsedMs = loopMinerInProgress
                      ? (liveRunStatus?.liveProgress?.totalElapsedMs ?? null)
                      : (latestLoopMinerRun.summary.debugTrace?.totalElapsedMs ?? latestLoopMinerRun.summary.durationMs ?? null);
                    if (!phases?.length && !loopMinerInProgress) return null;
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Phase Timings
                            {loopMinerInProgress ? <Loader2 className="h-3 w-3 animate-spin text-slate-400" /> : null}
                          </div>
                          <div className="text-xs text-slate-400">
                            {totalElapsedMs != null ? `elapsed ${formatDuration(totalElapsedMs)}` : "waiting for first phase…"}
                          </div>
                        </div>
                        {phases?.length ? (
                          <div className="space-y-1">
                            {phases.map((phase) => (
                              <div
                                key={`${phase.phase}-${phase.startedAt}`}
                                className={`border p-2 text-xs leading-5 ${phase.status === "running" ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white"} text-slate-600`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                                    {phase.status === "running" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-500" /> : null}
                                    {loopMinerPhaseLabel(phase.phase)}
                                  </div>
                                  <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] ${pillClass(phase.status === "completed" ? "completed" : phase.status === "failed" ? "failed" : phase.status === "skipped" ? "rejected" : "running")}`}>
                                    {phase.status}
                                  </span>
                                </div>
                                {phase.durationMs != null ? <div>{formatDuration(phase.durationMs)}</div> : null}
                                {phase.details ? (
                                  <div className="mt-1 break-all text-[11px] text-slate-500">
                                    {Object.entries(phase.details).slice(0, 6).map(([key, value]) => `${key}=${String(value)}`).join(" · ")}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="border border-blue-100 bg-blue-50 p-3 text-xs text-blue-600">
                            Starting up… first phase will appear here in a few seconds.
                          </div>
                        )}
                        {loopMinerInProgress && liveRunStatus ? (
                          <div className="grid grid-cols-4 gap-2 text-center">
                            {[
                              ["episodes", liveRunStatus.episodesBuilt],
                              ["loops", liveRunStatus.loopsDetected],
                              ["qualified", liveRunStatus.loopsQualified],
                              ["suggestions", liveRunStatus.suggestionsCreated],
                            ].map(([label, value]) => (
                              <div key={label} className="border border-blue-100 bg-blue-50 p-2">
                                <div className="text-lg font-semibold text-blue-800">{value}</div>
                                <div className="text-[11px] text-blue-500">{label}</div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}

                  {latestLoopMinerRun.summary.patternTrace ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pattern Trace</div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        {[
                          ["candidates", latestLoopMinerRun.summary.patternTrace.candidateGroups.length],
                          ["approved", latestLoopMinerRun.summary.patternTrace.approvedGroups.length],
                          ["rejected", latestLoopMinerRun.summary.patternTrace.rejectedGroups.length],
                        ].map(([label, value]) => (
                          <div key={label} className="border border-slate-200 bg-white p-2">
                            <div className="text-sm font-semibold text-slate-900">{value}</div>
                            <div className="text-[11px] text-slate-500">{label}</div>
                          </div>
                        ))}
                      </div>
                      {latestLoopMinerRun.summary.patternTrace.candidateGroups.length > 0 ? (
                        <div className="space-y-1">
                          {latestLoopMinerRun.summary.patternTrace.candidateGroups.slice(0, 4).map((group) => {
                            const decision = latestLoopMinerRun.summary.patternTrace?.judgeDecisions.find((item) => item.candidateGroupId === group.id);
                            const rejected = latestLoopMinerRun.summary.patternTrace?.rejectedGroups.find((item) => item.candidateGroupId === group.id);
                            return (
                              <div key={group.id} className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="font-semibold text-slate-800">{group.title}</div>
                                  <span className="shrink-0 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">
                                    {decision?.status ?? rejected?.status ?? "candidate"}
                                  </span>
                                </div>
                                <div>{group.episodeIds.length} episodes | {Math.round(group.confidence * 100)}% pattern confidence</div>
                                <div className="truncate">Artifact: {group.sharedArtifact} | Actions: {group.sharedActions.slice(0, 4).join(", ") || "unknown"}</div>
                                {(decision?.rationale ?? rejected?.rationale) ? (
                                  <div className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-500">{decision?.rationale ?? rejected?.rationale}</div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : latestLoopMinerRun.summary.episodesBuilt > 0 ? (
                        <div className="border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">
                          No candidate groups survived pattern similarity. This run built episodes but did not find repeated work behavior.
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {latestLoopMinerRun.summary.warnings && latestLoopMinerRun.summary.warnings.length > 0 ? (
                    <div className="border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-800">
                      <div className="font-semibold">Warnings</div>
                      {latestLoopMinerRun.summary.warnings.slice(0, 3).map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  ) : null}

                  {latestLoopMinerRun.status === "failed" && Object.keys(readRecord(latestLoopMinerRun.error)).length > 0 ? (
                    <div className="border border-rose-200 bg-rose-50 p-2 text-xs leading-5 text-rose-700">
                      <div className="font-semibold">Error</div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(latestLoopMinerRun.error, null, 2)}</pre>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Episode Embedding Map</div>
                      {latestLoopEmbeddingMap ? (
                        <div className="text-[11px] text-slate-400">
                          {latestLoopEmbeddingMap.meta.mappedEpisodes}/{latestLoopEmbeddingMap.meta.totalEpisodes} mapped
                        </div>
                      ) : null}
                    </div>
                    {latestLoopEmbeddingLoading ? (
                      <div className="border border-slate-200 bg-white p-3 text-sm text-slate-500">
                        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
                        Loading embedding projection...
                      </div>
                    ) : latestLoopEmbeddingError ? (
                      <div className="border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{latestLoopEmbeddingError}</div>
                    ) : !latestLoopEmbeddingMap ? (
                      <div className="border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">
                        Run Loop Miner to generate episode embeddings.
                      </div>
                    ) : latestLoopEmbeddingMap.points.length === 0 ? (
                      <div className="border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">
                        {latestLoopEmbeddingMap.meta.reason ?? "No episode vectors available for this run yet."}
                      </div>
                    ) : (
                      <>
                        <div className="border border-slate-200 bg-white p-2">
                          <svg viewBox="0 0 600 330" className="h-[220px] w-full">
                            <rect x="0" y="0" width="600" height="330" fill="#ffffff" />
                            <line x1="300" y1="24" x2="300" y2="306" stroke="#cbd5e1" strokeDasharray="4 4" />
                            <line x1="24" y1="165" x2="576" y2="165" stroke="#cbd5e1" strokeDasharray="4 4" />
                            {latestLoopEmbeddingMap.points.map((point) => {
                              const x = 24 + (((point.x + 1) / 2) * 552);
                              const y = 306 - (((point.y + 1) / 2) * 282);
                              const radius = Math.max(4, Math.min(10, 4 + Math.sqrt(Math.max(1, point.turnCount))));
                              const color = outputTypeColor(point.outputType);
                              return (
                                <circle key={point.episodeId} cx={x} cy={y} r={radius} fill={color} fillOpacity={0.82} stroke="#ffffff" strokeWidth="1.5">
                                  <title>{`${point.intent} (${point.outputType}) · ${point.turnCount} turns`}</title>
                                </circle>
                              );
                            })}
                          </svg>
                        </div>
                        <div className="flex flex-wrap gap-1.5 text-[11px]">
                          {Object.entries(
                            latestLoopEmbeddingMap.points.reduce<Record<string, number>>((counts, point) => {
                              counts[point.outputType] = (counts[point.outputType] ?? 0) + 1;
                              return counts;
                            }, {})
                          )
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 8)
                            .map(([outputType, count]) => (
                              <span key={outputType} className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: outputTypeColor(outputType) }} />
                                {outputType} ({count})
                              </span>
                            ))}
                        </div>
                        {latestLoopEmbeddingMap.meta.missingEpisodeIds.length > 0 ? (
                          <div className="text-[11px] text-slate-400">
                            {latestLoopEmbeddingMap.meta.missingEpisodeIds.length} episode(s) missing vectors
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Generated Suggestions</div>
                    {latestLoopMinerRun.suggestions.length === 0 ? (
                      <div className="border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No workflow suggestions created by this run.</div>
                    ) : (
                      latestLoopMinerRun.suggestions.map((suggestion) => {
                        const dna = suggestionDna(suggestion);
                        const trigger = readRecord(dna.trigger);
                        const steps = readStringList(dna.stepPattern);
                        return (
                          <div key={suggestion.id} className="border border-slate-200 bg-white p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-900">{suggestion.title}</div>
                                <div className="truncate font-mono text-[11px] text-slate-400">{suggestion.fingerprint}</div>
                              </div>
                              <span className="shrink-0 border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{Math.round(suggestion.confidence * 100)}%</span>
                            </div>
                            <p className="mt-2 text-sm leading-5 text-slate-600">{suggestion.reason}</p>
                            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                              <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600">{String(trigger.type ?? "schedule")}</span>
                              <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600">{String(trigger.cadence ?? "unknown cadence")}</span>
                              <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600">{suggestion.triggerCount} episodes</span>
                              {typeof dna.approvalBehavior === "string" ? (
                                <span className="border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">{dna.approvalBehavior}</span>
                              ) : null}
                            </div>
                            {steps.length > 0 ? (
                              <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-slate-600">
                                {steps.slice(0, 4).map((step) => (
                                  <li key={step}>{step}</li>
                                ))}
                              </ol>
                            ) : null}
                            <div className="mt-2 border border-slate-100 bg-slate-50 p-2 text-xs leading-5 text-slate-600">{suggestion.suggestedPrompt}</div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Episodes</div>
                    {latestLoopMinerRun.episodes.length === 0 ? (
                      <div className="border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No episodes were built in this run.</div>
                    ) : (
                      latestLoopMinerRun.episodes.slice(0, 6).map((episode) => (
                        <div key={episode.id} className="border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-slate-900">{episode.intent}</div>
                              <div className="text-[11px] text-slate-400">{dateLabel(episode.sealedAt)} · {episode.turnCount} turns</div>
                            </div>
                            <span className="shrink-0 border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">{episode.outputType}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                            {episode.sources.slice(0, 4).map((source) => (
                              <span key={source} className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600">{source}</span>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {loopMinerRuns.length > 1 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent Loop Miner Runs</div>
                      {loopMinerRuns.slice(0, 5).map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className="flex w-full items-center justify-between border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
                          onClick={() => setActiveLoopMinerRun(run)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[11px] text-slate-500">{run.id}</span>
                            <span className="text-xs text-slate-400">{run.summary.episodesBuilt} episodes · {run.summary.suggestionsCreated} suggestions</span>
                          </span>
                          <span className={`ml-2 shrink-0 border px-2 py-0.5 text-[11px] ${pillClass(run.status)}`}>{run.status}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 px-4 py-3">
              <CardTitle className="text-sm font-semibold text-slate-900">Proposals</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[560px] space-y-3 overflow-auto p-4">
              {!activeRun || activeRun.proposals.length === 0 ? (
                <div className="text-sm text-slate-500">No proposals yet.</div>
              ) : (
                activeRun.proposals.map((proposal) => (
                  <div key={proposal.id} className="border border-slate-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {phaseIcon(proposal.status)}
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900">{proposal.proposalType}</div>
                          <div className="truncate text-[11px] text-slate-400">{proposal.id}</div>
                        </div>
                      </div>
                      <span className={`shrink-0 border px-2 py-0.5 text-[11px] font-medium ${pillClass(proposal.status)}`}>{proposal.status}</span>
                    </div>
                    <p className="mt-2 text-sm leading-5 text-slate-600">{proposal.rationale}</p>
                    {proposal.proposedContent ? (
                      <div className="mt-2 border border-slate-100 bg-slate-50 p-2 text-xs leading-5 text-slate-600">{proposal.proposedContent}</div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                      {proposal.bucket ? (
                        <span className="border border-slate-200 bg-white px-2 py-0.5 text-slate-600">{proposal.bucket.replace("_", " ")}</span>
                      ) : null}
                      <span className={`border px-2 py-0.5 ${pillClass(proposal.riskLevel)}`}>risk {proposal.riskLevel}</span>
                      <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-500">{Math.round((proposal.bucketConfidence ?? proposal.confidence) * 100)}% confidence</span>
                      <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-500">{proposal.sourceMemoryIds.length} source</span>
                    </div>
                    <button
                      type="button"
                      className="mt-3 text-xs font-medium text-slate-700 underline-offset-4 hover:underline"
                      onClick={() => toggleTrace(proposal.id)}
                    >
                      {expandedTraceIds.has(proposal.id) ? "Hide agent trace" : "Show agent trace"}
                    </button>
                    {expandedTraceIds.has(proposal.id) ? (
                      <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                        <TraceBlock title="Phase 1 · Consolidator" value={proposal.trace?.consolidator} />
                        <TraceBlock title="Phase 2 · Adversary" value={proposal.trace?.adversary} />
                        <TraceBlock title="Phase 3 · Debate" value={proposal.trace?.debate} />
                        <TraceBlock title="Phase 4 · Judge" value={proposal.trace?.judge} />
                        <TraceBlock title="Phase 5 · Apply" value={proposal.trace?.apply} />
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="border-b border-slate-100 px-4 py-3">
              <CardTitle className="text-sm font-semibold text-slate-900">Recent Runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4">
              {runs.length === 0 ? (
                <div className="text-sm text-slate-500">No cleanup runs yet.</div>
              ) : (
                runs.slice(0, 8).map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className="flex w-full items-center justify-between border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => setActiveRun(run)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-slate-500">{run.id}</span>
                      <span className="text-xs text-slate-400">{run.dryRun ? "dry run" : "applied"} · {run.summary.proposed} proposed</span>
                    </span>
                    <span className={`ml-2 shrink-0 border px-2 py-0.5 text-[11px] ${pillClass(run.status)}`}>{run.status}</span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}

function TraceBlock({ title, value }: { title: string; value: unknown }) {
  const pretty = JSON.stringify(value ?? {}, null, 2);
  return (
    <div className="border border-slate-200 bg-slate-950">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-200">{title}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 text-slate-100">
        {pretty}
      </pre>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import {
  Bot,
  Check,
  ChevronRight,
  Code,
  Columns2,
  FileText,
  Eye,
  Info,
  ListChecks,
  Loader2,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArtifactRenderer } from "@/components/renderers";
import type { CanvasEmailTemplate } from "./components/canvas-email-editor";

type UsageSummary = {
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

type StepAttempt = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: { id?: string; name?: string; task?: string };
  attempt: number;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  output_json: { text?: string; data?: Record<string, unknown>; goalEval?: { reason?: string } };
  error_json: { message?: string };
};

type RunEvent = {
  id: string;
  created_at: string;
  event_type: string;
  step_attempt_id: string | null;
  payload_json: Record<string, unknown>;
};

type Gate = {
  id: string;
  gate_type: "memory_confirmation" | "missing_input" | "draft_review" | "pre_send";
  status: string;
  question: string;
  payload_json: { items?: MemoryGateItem[]; result?: { text?: string } } & Record<string, unknown>;
};

type MemoryGateItem = {
  id: string;
  excerpt: string;
  include?: boolean;
  score?: number;
  confidence?: number;
  reason?: string;
  evidenceRole?: string;
  metadata?: Record<string, unknown>;
};

type Artifact = {
  id: string;
  step_attempt_id: string | null;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  data_json?: {
    renderTarget?: string;
    emailTemplate?: CanvasEmailTemplate;
  };
  invalidated_at: string | null;
};

type RunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  error_json: { message?: string };
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  current_step_index: number | null;
  definition?: {
    goal?: string;
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name?: string; task?: string }>;
    };
  };
  context?: Record<string, unknown>;
  steps: StepAttempt[];
  gates: Gate[];
  artifacts: Artifact[];
  events: RunEvent[];
};

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "blocked"]);
const currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numberFormatter = new Intl.NumberFormat("en-US");
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function label(value: string) {
  return value.replaceAll("_", " ");
}

function preview(value: string | undefined | null, fallback: string | number = "No output yet.", maxChars = 128) {
  const resolvedMaxChars = typeof fallback === "number" ? fallback : maxChars;
  const resolvedFallback = typeof fallback === "string" ? fallback : "No output yet.";
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return resolvedFallback;
  return text.length > resolvedMaxChars ? `${text.slice(0, Math.max(0, resolvedMaxChars - 3))}...` : text;
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function inferGoalArtifactName(run: RunProjection | null, artifact?: Artifact | null) {
  const source = `${run?.definition?.goal ?? ""} ${run?.workflow_title ?? ""} ${artifact?.artifact_key ?? ""} ${artifact?.kind ?? ""}`.toLowerCase();
  if (source.includes("newsletter")) return "Newsletter";
  if (source.includes("report")) return "Report";
  if (source.includes("proposal")) return "Proposal";
  if (source.includes("brief")) return "Brief";
  if (source.includes("summary")) return "Summary";
  if (source.includes("plan")) return "Plan";
  if (source.includes("draft")) return "Draft";
  if (artifact?.kind) return titleCase(artifact.kind);
  if (artifact?.artifact_key) return titleCase(artifact.artifact_key);
  return "Final result";
}

function badgeClass(status: string) {
  if (status === "succeeded" || status === "approved" || status === "submitted") return "bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "blocked" || status === "cancelled" || status === "rejected") return "bg-red-50 text-red-700";
  if (status === "waiting_for_gate" || status === "pending") return "bg-amber-100 text-amber-700";
  if (status === "running") return "bg-sky-100 text-sky-700";
  return "bg-slate-100 text-slate-600";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={cn("rounded-full border-0 px-3 py-1 text-xs font-bold capitalize", badgeClass(status))}>
      {label(status)}
    </Badge>
  );
}

function RunStatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold capitalize", badgeClass(status))}>
      <span className="size-2 rounded-full bg-amber-400" />
      {label(status)}
    </span>
  );
}

function getStepText(step: StepAttempt | null | undefined) {
  return step?.output_json?.text?.trim() ?? "";
}

function agentVisual(step: StepAttempt | null | undefined) {
  const source = `${step?.agent_snapshot?.name ?? ""} ${step?.agent_snapshot?.task ?? ""}`.toLowerCase();
  if (source.includes("memory") || source.includes("search")) return { icon: Search, className: "bg-cyan-100 text-sky-700" };
  if (source.includes("draft") || source.includes("write") || source.includes("content")) return { icon: PenLine, className: "bg-indigo-100 text-indigo-700" };
  if (source.includes("input") || source.includes("validat")) return { icon: ListChecks, className: "bg-slate-100 text-slate-600" };
  if (source.includes("approval") || source.includes("review") || step?.status === "waiting_for_gate") return { icon: ShieldCheck, className: "bg-amber-100 text-amber-700" };
  if (step?.status === "running") return { icon: Bot, className: "bg-sky-100 text-sky-700" };
  if (step?.status === "succeeded") return { icon: Check, className: "bg-emerald-100 text-emerald-700" };
  if (step?.status === "failed" || step?.status === "blocked") return { icon: X, className: "bg-red-100 text-red-700" };
  return { icon: Bot, className: "bg-slate-100 text-slate-600" };
}

function readContextEntries(context: Record<string, unknown> | undefined): Array<{ key: string; value: string }> {
  const inputs = context?.inputs && typeof context.inputs === "object" && !Array.isArray(context.inputs)
    ? context.inputs as Record<string, unknown>
    : {};
  const memories = Array.isArray(context?.approvedMemories) ? context.approvedMemories : [];
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(inputs)) {
    rows.push({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
  }
  for (const item of memories) {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      rows.push({
        key: typeof record.id === "string" ? record.id : "memory",
        value: typeof record.excerpt === "string" ? record.excerpt : JSON.stringify(record),
      });
    }
  }
  return rows.slice(0, 5);
}

function emptyUsageSummary(): UsageSummary {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    estimatedCostUsd: 0,
    models: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeUsageSummary(target: UsageSummary, source: unknown): void {
  if (!isPlainObject(source)) return;
  target.calls += Number(source.calls ?? 0);
  target.promptTokens += Number(source.promptTokens ?? 0);
  target.completionTokens += Number(source.completionTokens ?? 0);
  target.totalTokens += Number(source.totalTokens ?? 0);
  target.estimatedPromptTokens += Number(source.estimatedPromptTokens ?? 0);
  target.estimatedCompletionTokens += Number(source.estimatedCompletionTokens ?? 0);
  target.estimatedTotalTokens += Number(source.estimatedTotalTokens ?? 0);
  target.estimatedCostUsd += Number(source.estimatedCostUsd ?? 0);
  const models = isPlainObject(source.models) ? source.models : {};
  for (const [model, count] of Object.entries(models)) {
    target.models[model] = (target.models[model] ?? 0) + Number(count ?? 0);
  }
}

function collectUsageSummaries(value: unknown, target = emptyUsageSummary(), seen = new WeakSet<object>()): UsageSummary {
  if (!value || typeof value !== "object") return target;
  if (seen.has(value)) return target;
  seen.add(value);

  if (isPlainObject(value)) {
    const hasUsageShape =
      typeof value.calls === "number" ||
      typeof value.promptTokens === "number" ||
      typeof value.completionTokens === "number" ||
      typeof value.totalTokens === "number" ||
      typeof value.estimatedPromptTokens === "number" ||
      typeof value.estimatedCompletionTokens === "number" ||
      typeof value.estimatedTotalTokens === "number" ||
      typeof value.estimatedCostUsd === "number" ||
      isPlainObject(value.models);
    if (hasUsageShape) mergeUsageSummary(target, value);
  }

  for (const entry of Object.values(value)) {
    collectUsageSummaries(entry, target, seen);
  }
  return target;
}

function formatJsonPreview(value: unknown, maxChars = 480): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      })();
  const text = raw.trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]` : text;
}

function formatJsonFull(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

type MemorySearchSource = {
  id: string;
  text: string;
  score?: number;
  confidence?: number;
  reason?: string;
  evidenceRole?: string;
  metadata?: Record<string, unknown>;
};

type MemorySearchTraceEntry = {
  step: StepAttempt;
  query: string | null;
  queryPlan: Record<string, unknown> | null;
  retrieval: {
    vectorQueries: Array<{
      query: string;
      hitCount: number;
      topMatches: Array<{ id: string; score: number }>;
    }>;
    lexicalMatchCount: number;
    mergedCandidateCount: number;
  } | null;
  validation: {
    acceptedCount: number;
    acceptedIds: string[];
    rejectedCount: number;
    confidence: string | null;
    noEvidenceReason: string | null;
  } | null;
  candidates: Array<{
    id: string;
    text: string;
    score: number;
    metadata?: Record<string, unknown>;
    accepted: boolean;
    acceptedConfidence?: number;
    acceptedReason?: string;
    evidenceRole?: string;
  }>;
  sources: MemorySearchSource[];
};

function readMemorySearchSourceRow(row: unknown): MemorySearchSource | null {
  const item = isPlainObject(row) ? row : {};
  const id = typeof item.id === "string" ? item.id : "";
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || !text) return null;
  return {
    id,
    text,
    ...(typeof item.score === "number" ? { score: item.score } : {}),
    ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    ...(typeof item.evidenceRole === "string" ? { evidenceRole: item.evidenceRole } : {}),
    ...(isPlainObject(item.metadata) ? { metadata: item.metadata } : {}),
  };
}

function extractMemorySearchSources(data: unknown): MemorySearchSource[] {
  const root = isPlainObject(data) ? data : {};
  const seen = new Set<string>();
  const rows: MemorySearchSource[] = [];

  const pushRow = (row: unknown) => {
    const parsed = readMemorySearchSourceRow(row);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    rows.push(parsed);
  };

  for (const row of Array.isArray(root.sources) ? root.sources : []) {
    pushRow(row);
  }

  for (const toolResult of Array.isArray(root.toolResults) ? root.toolResults : []) {
    const item = isPlainObject(toolResult) ? toolResult : {};
    if (item.ref !== "internal.memory_search") continue;
    const toolData = isPlainObject(item.data) ? item.data : {};
    for (const row of Array.isArray(toolData.sources) ? toolData.sources : []) {
      pushRow(row);
    }
  }

  return rows;
}

function readMemoryGateItems(gate: Gate | null | undefined): MemoryGateItem[] {
  const rawItems = Array.isArray(gate?.payload_json.items) ? gate.payload_json.items : [];
  return rawItems
    .map((row): MemoryGateItem | null => {
      const item: Record<string, unknown> = isPlainObject(row) ? row : {};
      const id = typeof item.id === "string" ? item.id : "";
      const excerpt = typeof item.excerpt === "string"
        ? item.excerpt
        : typeof item.text === "string"
          ? item.text
          : "";
      if (!id || !excerpt) return null;
      return {
        id,
        excerpt,
        include: item.include !== false,
        ...(typeof item.score === "number" ? { score: item.score } : {}),
        ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
        ...(typeof item.evidenceRole === "string" ? { evidenceRole: item.evidenceRole } : {}),
        ...(isPlainObject(item.metadata) ? { metadata: item.metadata } : {}),
      };
    })
    .filter((item): item is MemoryGateItem => item !== null);
}

function buildMemoryGateDecisionItems(items: MemoryGateItem[], selectedIds: Set<string>): MemoryGateItem[] {
  return items.map((item) => ({
    ...item,
    include: selectedIds.has(item.id),
  }));
}

function memoryItemSummary(item: MemoryGateItem) {
  return item.excerpt.replace(/\s+/g, " ").trim();
}

function MemoryEditCanvas({
  gateId,
  items,
  selectedIds,
  onToggle,
  onInspect,
  compact = false,
}: {
  gateId: string;
  items: MemoryGateItem[];
  selectedIds: Set<string>;
  onToggle: (gateId: string, memoryId: string, checked: boolean) => void;
  onInspect: (item: MemoryGateItem) => void;
  compact?: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-white/70 p-4 text-sm font-medium text-slate-500">
        canvas.memory_edit has no validated memories to review.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-sky-100 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-extrabold text-[#172139]">canvas.memory_edit</p>
            <Badge variant="secondary" className="rounded-full bg-sky-50 text-sky-700">
              {selectedIds.size}/{items.length} selected
            </Badge>
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Select the memories that should be passed to the next agent.
          </p>
        </div>
      </div>
      <div className={cn("divide-y", compact ? "max-h-64 overflow-y-auto" : "")}>
        {items.map((item) => {
          const selected = selectedIds.has(item.id);
          const summary = memoryItemSummary(item);
          return (
            <div
              key={item.id}
              className={cn(
                "grid gap-3 px-4 py-4 transition sm:grid-cols-[auto_minmax(180px,260px)_minmax(0,1fr)_auto]",
                selected ? "bg-sky-50/45" : "bg-white",
              )}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={(checked) => onToggle(gateId, item.id, checked === true)}
                aria-label={`Include memory ${item.id}`}
                className="mt-1"
              />
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Memory ID</p>
                <button
                  type="button"
                  onClick={() => onInspect(item)}
                  className="mt-1 block max-w-full truncate font-mono text-xs font-semibold text-slate-800 underline-offset-2 hover:underline"
                  title={item.id}
                >
                  {item.id}
                </button>
              </div>
              <button
                type="button"
                onClick={() => onInspect(item)}
                className="min-w-0 text-left"
              >
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Memory content</p>
                <p className={cn("mt-1 text-sm font-medium leading-6 text-slate-700", compact ? "line-clamp-2" : "line-clamp-3")}>
                  {summary}
                </p>
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onInspect(item)}
                className="self-start rounded-full"
              >
                <Eye className="mr-1 size-3.5" />
                View
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function extractMemorySearchTracesFromSteps(steps: StepAttempt[]): MemorySearchTraceEntry[] {
  const traces: MemorySearchTraceEntry[] = [];

  for (const step of steps) {
    const data = step.output_json?.data;
    if (!isPlainObject(data)) continue;
    const toolResults = Array.isArray(data.toolResults) ? data.toolResults : [];
    for (const toolResult of toolResults) {
      const item = isPlainObject(toolResult) ? toolResult : {};
      if (item.ref !== "internal.memory_search") continue;
      const toolData = isPlainObject(item.data) ? item.data : {};
      const trace = isPlainObject(toolData.trace) ? toolData.trace : {};
      const queryPlan = isPlainObject(trace.queryPlan)
        ? trace.queryPlan
        : (isPlainObject(toolData.queryPlan) ? toolData.queryPlan : null);
      const retrieval = isPlainObject(trace.retrieval)
        ? trace.retrieval
        : null;
      const validation = isPlainObject(trace.validation)
        ? trace.validation
        : null;
      const candidates = Array.isArray(trace.candidates)
        ? trace.candidates
            .map((candidate) => {
              const itemCandidate = isPlainObject(candidate) ? candidate : {};
              return {
                id: typeof itemCandidate.id === "string" ? itemCandidate.id : "",
                text: typeof itemCandidate.text === "string" ? itemCandidate.text : "",
                score: typeof itemCandidate.score === "number" ? itemCandidate.score : 0,
                ...(isPlainObject(itemCandidate.metadata) ? { metadata: itemCandidate.metadata } : {}),
                accepted: Boolean(itemCandidate.accepted),
                ...(typeof itemCandidate.acceptedConfidence === "number" ? { acceptedConfidence: itemCandidate.acceptedConfidence } : {}),
                ...(typeof itemCandidate.acceptedReason === "string" ? { acceptedReason: itemCandidate.acceptedReason } : {}),
                ...(typeof itemCandidate.evidenceRole === "string" ? { evidenceRole: itemCandidate.evidenceRole } : {}),
              };
            })
            .filter((candidate) => Boolean(candidate.id))
        : [];
      traces.push({
        step,
        query: typeof trace.query === "string"
          ? trace.query
          : (typeof toolData.query === "string" ? toolData.query : null),
        queryPlan,
        retrieval: retrieval
          ? {
              vectorQueries: Array.isArray(retrieval.vectorQueries)
                ? retrieval.vectorQueries
                    .map((query) => {
                      const itemQuery = isPlainObject(query) ? query : {};
                      return {
                        query: typeof itemQuery.query === "string" ? itemQuery.query : "",
                        hitCount: typeof itemQuery.hitCount === "number" ? itemQuery.hitCount : 0,
                        topMatches: Array.isArray(itemQuery.topMatches)
                          ? itemQuery.topMatches
                              .map((match) => {
                                const itemMatch = isPlainObject(match) ? match : {};
                                return {
                                  id: typeof itemMatch.id === "string" ? itemMatch.id : "",
                                  score: typeof itemMatch.score === "number" ? itemMatch.score : 0,
                                };
                              })
                              .filter((match) => Boolean(match.id))
                          : [],
                      };
                    })
                    .filter((query) => Boolean(query.query))
                : [],
              lexicalMatchCount: typeof retrieval.lexicalMatchCount === "number" ? retrieval.lexicalMatchCount : 0,
              mergedCandidateCount: typeof retrieval.mergedCandidateCount === "number" ? retrieval.mergedCandidateCount : 0,
            }
          : null,
        validation: validation
          ? {
              acceptedCount: typeof validation.acceptedCount === "number" ? validation.acceptedCount : 0,
              acceptedIds: Array.isArray(validation.acceptedIds)
                ? validation.acceptedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
                : [],
              rejectedCount: typeof validation.rejectedCount === "number" ? validation.rejectedCount : 0,
              confidence: typeof validation.confidence === "string" ? validation.confidence : null,
              noEvidenceReason: typeof validation.noEvidenceReason === "string" ? validation.noEvidenceReason : null,
            }
          : null,
        candidates,
        sources: extractMemorySearchSources(toolData),
      });
    }
  }

  return traces;
}

export default function StableLoopRunPage() {
  const { workflowId, runId } = useParams<{ workflowId: string; runId: string }>();
  const [run, setRun] = useState<RunProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [memorySelections, setMemorySelections] = useState<Record<string, string[]>>({});
  const [memoryDetail, setMemoryDetail] = useState<MemoryGateItem | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"output" | "attempts" | "artifact">("output");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to load run");
      setRun(payload.run as RunProjection);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [run, load]);

  const orderedSteps = useMemo(
    () => [...(run?.steps ?? [])].sort((a, b) => a.step_index - b.step_index || a.attempt - b.attempt),
    [run],
  );
  const stepUsageRows = useMemo(() => orderedSteps.map((step) => ({
    step,
    usage: collectUsageSummaries(step.output_json?.data),
  })), [orderedSteps]);
  const usageSummary = useMemo(() => {
    const summary = emptyUsageSummary();
    for (const row of stepUsageRows) {
      mergeUsageSummary(summary, row.usage);
    }
    return summary;
  }, [stepUsageRows]);
  const usageModels = useMemo(
    () => Object.entries(usageSummary.models).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    [usageSummary.models],
  );
  const latestSteps = useMemo(() => {
    const byStep = new Map<number, StepAttempt>();
    for (const step of orderedSteps) byStep.set(step.step_index, step);
    return [...byStep.values()].sort((a, b) => a.step_index - b.step_index);
  }, [orderedSteps]);
  const visibleArtifacts = useMemo(() => run?.artifacts.filter((artifact) => !artifact.invalidated_at) ?? [], [run]);
  const latestArtifacts = useMemo(() => {
    const byKey = new Map<string, Artifact>();
    for (const artifact of visibleArtifacts) {
      const current = byKey.get(artifact.artifact_key);
      if (!current || artifact.version > current.version) byKey.set(artifact.artifact_key, artifact);
    }
    return [...byKey.values()].sort((a, b) => a.artifact_key.localeCompare(b.artifact_key));
  }, [visibleArtifacts]);
  const finalArtifacts = useMemo(
    () => latestArtifacts.filter((artifact) => artifact.kind !== "structured_output"),
    [latestArtifacts],
  );
  const pendingGate = useMemo(() => run?.gates.find((gate) => gate.status === "pending") ?? null, [run]);
  const memoryGateItems = useMemo(
    () => pendingGate?.gate_type === "memory_confirmation" ? readMemoryGateItems(pendingGate) : [],
    [pendingGate],
  );
  const selectedMemoryIds = useMemo(
    () => new Set(memorySelections[pendingGate?.id ?? ""] ?? memoryGateItems.filter((item) => item.include !== false).map((item) => item.id)),
    [memoryGateItems, memorySelections, pendingGate?.id],
  );
  const selectedStep = useMemo(() => {
    if (selectedStepId) return orderedSteps.find((step) => step.id === selectedStepId) ?? null;
    return [...orderedSteps].reverse().find((step) => getStepText(step) || step.status === "waiting_for_gate" || step.status === "running") ?? null;
  }, [orderedSteps, selectedStepId]);
  const selectedStepContext = selectedStepId ? selectedStep : null;
  const latestArtifact = finalArtifacts.at(-1) ?? null;
  const selectedArtifact = useMemo(() => {
    if (!selectedArtifactId) return null;
    return visibleArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  }, [selectedArtifactId, visibleArtifacts]);
  const selectedArtifactStep = useMemo(() => {
    if (!selectedArtifact?.step_attempt_id) return null;
    return orderedSteps.find((step) => step.id === selectedArtifact.step_attempt_id) ?? null;
  }, [orderedSteps, selectedArtifact]);
  const activeArtifact = selectedArtifact ?? latestArtifact;
  const attemptsForSelectedStep = useMemo(() => {
    const attemptContextStep = selectedStepContext ?? selectedArtifactStep ?? selectedStep;
    if (!attemptContextStep) return [];
    return orderedSteps.filter((step) => step.step_index === attemptContextStep.step_index);
  }, [orderedSteps, selectedArtifactStep, selectedStep, selectedStepContext]);

  const finalArtifactName = inferGoalArtifactName(run, activeArtifact);
  const activeCanvasArtifact = useMemo(() => {
    const gateCanvasKey = typeof pendingGate?.payload_json.canvasArtifactKey === "string"
      ? pendingGate.payload_json.canvasArtifactKey
      : null;
    if (gateCanvasKey) {
      const fromGate = finalArtifacts.find((artifact) => artifact.artifact_key === gateCanvasKey);
      if (fromGate) return fromGate;
    }
    if (selectedArtifact?.kind === "canvas_email" || selectedArtifact?.kind === "canvas_preview") return selectedArtifact;
    if (selectedArtifact) {
      const paired = finalArtifacts.find(
        (artifact) =>
          artifact.artifact_key === `${selectedArtifact.artifact_key}:canvas.email` ||
          artifact.artifact_key === `${selectedArtifact.artifact_key}:canvas.preview`,
      );
      if (paired) return paired;
    }
    return finalArtifacts.find(
      (artifact) => artifact.kind === "canvas_email" || artifact.kind === "canvas_preview",
    ) ?? null;
  }, [finalArtifacts, pendingGate, selectedArtifact]);
  const activeCanvasTemplate = activeCanvasArtifact?.data_json?.emailTemplate ?? null;
  const inspectingAgentOutput = Boolean(selectedStepId && selectedStep);
  const centerTitle = inspectingAgentOutput
    ? `${selectedStep?.agent_snapshot?.name ?? selectedStep?.agent_id} output`
    : activeArtifact
      ? `${finalArtifactName} artifact`
      : `${finalArtifactName} artifact`;
  const centerBody = inspectingAgentOutput
    ? getStepText(selectedStep)
    : activeArtifact?.body || pendingGate?.payload_json.result?.text || getStepText(selectedStep);
  const contextEntries = readContextEntries(run?.context);
  const doneSteps = latestSteps.filter((step) => step.status === "succeeded").length;
  const gateHeading = pendingGate
    ? pendingGate.gate_type === "missing_input"
      ? "Input is needed to continue"
      : `${label(pendingGate.gate_type)} is ready for approval`
    : null;
  const artifactPanelArtifacts = useMemo(() => {
    if (selectedStepContext) {
      const attemptIds = new Set(attemptsForSelectedStep.map((attempt) => attempt.id));
      return visibleArtifacts
        .filter((artifact) => artifact.step_attempt_id ? attemptIds.has(artifact.step_attempt_id) : false)
        .sort((a, b) => a.artifact_key.localeCompare(b.artifact_key) || b.version - a.version);
    }
    if (selectedArtifact) {
      return visibleArtifacts
        .filter((artifact) => artifact.artifact_key === selectedArtifact.artifact_key)
        .sort((a, b) => b.version - a.version);
    }
    return finalArtifacts;
  }, [attemptsForSelectedStep, finalArtifacts, selectedArtifact, selectedStepContext, visibleArtifacts]);
  const artifactPanelTitle = selectedStepContext
    ? `${selectedStepContext.agent_snapshot?.name ?? selectedStepContext.agent_id} artifacts`
    : selectedArtifact
      ? `${inferGoalArtifactName(run, selectedArtifact)} artifact`
      : `${finalArtifactName} artifact`;
  const artifactPanelDescription = selectedStepContext
    ? "Artifacts produced by the selected step and its attempts."
    : selectedArtifact
      ? `Versions of ${selectedArtifact.artifact_key}.`
      : "This is the run result. Agent rows are intermediate work; the artifact is the reviewed end result.";
  const runLogEvents = useMemo(
    () => [...(run?.events ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [run],
  );

  async function post(path: string, body?: Record<string, unknown>) {
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Command failed");
      await load();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command failed");
    } finally {
      setBusy(null);
    }
  }

  const logEntries = useMemo(() => {
    const events = runLogEvents.map((event) => ({
      id: `event:${event.id}`,
      time: event.created_at,
      title: titleCase(event.event_type),
      status: event.event_type,
      body: formatJsonPreview(event.payload_json, 420),
    }));
    const steps = orderedSteps.map((step) => ({
      id: `step:${step.id}`,
      time: step.finished_at ?? step.started_at ?? step.created_at,
      title: `Step ${step.step_index + 1} · ${step.agent_snapshot?.name ?? step.agent_id}`,
      status: step.status,
      body: preview(
        getStepText(step) ||
          step.error_json?.message ||
          formatJsonPreview(step.output_json?.data, 520) ||
          "No step output yet.",
        520,
      ),
    }));
    return [...events, ...steps]
      .filter((entry) => Boolean(entry.time))
      .sort((left, right) => left.time.localeCompare(right.time));
  }, [orderedSteps, runLogEvents]);
  const memorySearchTraces = useMemo(
    () => extractMemorySearchTracesFromSteps(orderedSteps),
    [orderedSteps],
  );

  useEffect(() => {
    if (!pendingGate || pendingGate.gate_type !== "memory_confirmation") return;
    setMemorySelections((current) => {
      if (current[pendingGate.id]) return current;
      return {
        ...current,
        [pendingGate.id]: memoryGateItems.filter((item) => item.include !== false).map((item) => item.id),
      };
    });
  }, [memoryGateItems, pendingGate]);

  function toggleMemorySelection(gateId: string, memoryId: string, checked: boolean) {
    setMemorySelections((current) => {
      const currentIds = new Set(current[gateId] ?? memoryGateItems.filter((item) => item.include !== false).map((item) => item.id));
      if (checked) currentIds.add(memoryId);
      else currentIds.delete(memoryId);
      return {
        ...current,
        [gateId]: [...currentIds],
      };
    });
  }

  async function saveCanvasEmail(artifact: Artifact, value: { design: unknown; html: string; text?: string; subject?: string; preview?: string }) {
    await post(`/api/workflows/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifact_key)}/canvas/email`, value);
  }

  function submitGate(gate: Gate, action: "approve" | "input" | "reject") {
    if (action === "reject") {
      void post(`/api/workflows/runs/${runId}/gates/${gate.id}/reject`, { reason: "Rejected by operator" });
      return;
    }
    if (action === "input") {
      void post(`/api/workflows/runs/${runId}/gates/${gate.id}/input`, { value: inputValues[gate.id] ?? "" });
      return;
    }
    void post(`/api/workflows/runs/${runId}/gates/${gate.id}/approve`, {
      channel: "dashboard",
      ...(gate.gate_type === "memory_confirmation"
        ? {
            items: buildMemoryGateDecisionItems(
              readMemoryGateItems(gate),
              new Set(memorySelections[gate.id] ?? readMemoryGateItems(gate).filter((item) => item.include !== false).map((item) => item.id)),
            ),
          }
        : {}),
    });
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50">
        <Loader2 className="size-7 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!run) return <main className="p-8 text-sm text-red-700">{error ?? "Run not found"}</main>;

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-[#121a31]">
      <div className="mx-auto max-w-[1660px] px-7 py-6">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-500">
              <Link href="/dashboard/loops" className="hover:text-slate-900">Loops</Link>
              <ChevronRight className="size-4" />
              <Link href={`/dashboard/loops/${workflowId}`} className="hover:text-slate-900">{run.workflow_title}</Link>
              <ChevronRight className="size-4" />
              <span className="text-slate-900">Run {run.id.slice(0, 6)}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[25px] font-extrabold leading-tight tracking-[-0.02em]">{run.workflow_title}</h1>
              <RunStatusPill status={run.status} />
            </div>
          </div>
          <div className="flex items-center gap-3 text-slate-500">
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Info"><Info className="size-5" /></button>
            <button
              className="rounded-lg p-2 hover:bg-white hover:text-slate-900"
              title="Run details"
              onClick={() => setDetailsOpen(true)}
            >
              <Code className="size-5" />
            </button>
            <button onClick={() => void load()} className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Refresh"><RefreshCw className="size-5" /></button>
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Panels"><Columns2 className="size-5" /></button>
            {!terminalStatuses.has(run.status) ? (
              <button
                onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)}
                disabled={Boolean(busy)}
                className="rounded-lg p-2 hover:bg-white hover:text-red-700 disabled:opacity-50"
                title="Cancel"
              >
                <X className="size-5" />
              </button>
            ) : null}
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="More"><MoreHorizontal className="size-5" /></button>
          </div>
        </header>

        {error || run.error_json?.message ? (
          <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error ?? run.error_json?.message}
          </div>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_490px]">
          <section className="space-y-5">
            {pendingGate ? (
              <Card className="overflow-hidden rounded-[22px] border-0 bg-[#eefdff] shadow-md shadow-slate-300/60">
                <CardContent className="flex min-h-[178px] gap-5 p-7">
                  <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <ShieldCheck className="size-7 text-slate-700" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[19px] font-extrabold">{gateHeading}</h2>
                    <p className="mt-2 max-w-4xl text-[18px] font-medium leading-7 text-[#53627a]">
                      {pendingGate.gate_type === "missing_input"
                        ? pendingGate.question
                        : preview(centerBody || pendingGate.question || run.definition?.goal, "Review the current artifact and approve or request changes.")}
                    </p>
                    {pendingGate.gate_type === "missing_input" ? (
                      <textarea
                        value={inputValues[pendingGate.id] ?? ""}
                        onChange={(event) => setInputValues((current) => ({ ...current, [pendingGate.id]: event.target.value }))}
                        className="mt-5 min-h-28 w-full rounded-xl border border-cyan-200 bg-white p-3 text-sm outline-none focus:border-cyan-400"
                        placeholder="Provide the required input"
                      />
                    ) : null}
                    {pendingGate.gate_type === "memory_confirmation" ? (
                      <div className="mt-5">
                        <MemoryEditCanvas
                          gateId={pendingGate.id}
                          items={memoryGateItems}
                          selectedIds={selectedMemoryIds}
                          onToggle={toggleMemorySelection}
                          onInspect={setMemoryDetail}
                          compact
                        />
                      </div>
                    ) : null}
                    <div className="mt-7 flex flex-wrap items-center gap-4">
                      <Button
                        disabled={Boolean(busy) || (pendingGate.gate_type === "missing_input" && !(inputValues[pendingGate.id] ?? "").trim())}
                        onClick={() => submitGate(pendingGate, pendingGate.gate_type === "missing_input" ? "input" : "approve")}
                        className="h-9 rounded-lg bg-[#0077b6] px-5 text-[16px] font-bold shadow-md shadow-sky-800/20 hover:bg-[#00689f]"
                      >
                        <Check className="mr-2 size-4" />
                        {pendingGate.gate_type === "missing_input"
                          ? "Submit input"
                          : pendingGate.gate_type === "memory_confirmation"
                            ? "Approve selected"
                            : "Approve"}
                      </Button>
                      <Button variant="ghost" disabled={Boolean(busy)} onClick={() => submitGate(pendingGate, "reject")} className="text-[16px] font-semibold text-[#364761]">
                        Request changes
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card className="min-h-[860px] overflow-hidden rounded-[22px] border-0 bg-white shadow-sm">
              <Tabs value={leftTab} onValueChange={(value) => setLeftTab(value as typeof leftTab)} className="gap-0">
                <CardHeader className="border-b bg-gradient-to-r from-[#fffaf2] via-white to-[#f0fbff] px-7 py-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <CardTitle className="truncate text-[20px] font-bold text-[#35455f]">{centerTitle}</CardTitle>
                    </div>
                  </div>
                  <TabsList variant="line" className="mt-5 h-auto gap-1 rounded-none bg-transparent p-0">
                    <TabsTrigger value="output" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Output
                    </TabsTrigger>
                    <TabsTrigger value="attempts" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Attempts
                    </TabsTrigger>
                    <TabsTrigger value="artifact" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Artifact
                    </TabsTrigger>
                  </TabsList>
                </CardHeader>
                <CardContent className="p-7">
                    <TabsContent value="output" className="mt-0">
                      <div className="rounded-2xl border bg-white p-7 shadow-sm">
                        {pendingGate ? (
                          <div className="mb-6 flex items-start gap-4 rounded-2xl border border-amber-100 bg-amber-50 p-4">
                            <div className="grid size-12 place-items-center rounded-xl bg-amber-100 text-amber-700">
                              <ShieldCheck className="size-6" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-3">
                                <h3 className="text-[18px] font-extrabold">Awaiting operator response</h3>
                                <StatusBadge status="pending" />
                              </div>
                              <p className="mt-1 text-[15px] text-slate-600">
                                {pendingGate?.question ?? "The selected step is paused at a gate."}
                              </p>
                            </div>
                          </div>
                        ) : null}

                        {pendingGate?.gate_type === "memory_confirmation" ? (
                          <MemoryEditCanvas
                            gateId={pendingGate.id}
                            items={memoryGateItems}
                            selectedIds={selectedMemoryIds}
                            onToggle={toggleMemorySelection}
                            onInspect={setMemoryDetail}
                          />
                        ) : inspectingAgentOutput ? (
                          <div className="prose prose-slate max-w-none text-[16px] leading-7">
                            <Streamdown>{centerBody}</Streamdown>
                          </div>
                        ) : activeCanvasArtifact && activeCanvasTemplate ? (
                          <ArtifactRenderer
                            artifact={activeCanvasArtifact}
                            runId={runId}
                            saving={busy?.includes("/canvas/email") ?? false}
                            onSave={async (data) => {
                              await saveCanvasEmail(activeCanvasArtifact, data as Parameters<typeof saveCanvasEmail>[1]);
                            }}
                          />
                        ) : centerBody ? (
                          <div className="prose prose-slate max-w-none text-[16px] leading-7">
                            <Streamdown>{centerBody}</Streamdown>
                          </div>
                        ) : (
                          <div className="grid min-h-[560px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-center text-sm text-slate-500">
                            No {finalArtifactName.toLowerCase()} artifact yet. The stable worker will update this projection when the run produces its reviewed result.
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="attempts" className="mt-0">
                      <div className="space-y-4">
                        {(attemptsForSelectedStep.length > 0 ? attemptsForSelectedStep : orderedSteps).map((attempt) => (
                          <div key={attempt.id} className="rounded-2xl border bg-white p-5 shadow-sm">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Step {attempt.step_index + 1} · Attempt {attempt.attempt}</p>
                                <h3 className="mt-1 text-lg font-extrabold">{attempt.agent_snapshot?.name ?? attempt.agent_id}</h3>
                              </div>
                              <div className="flex items-center gap-2">
                                {(attempt.status === "failed" || attempt.status === "cancelled") ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={Boolean(busy)}
                                    onClick={() => void post(`/api/workflows/runs/${runId}/steps/${attempt.id}/retry`)}
                                    className="rounded-full"
                                  >
                                    <RotateCcw className="mr-1 size-3" />
                                    Rerun
                                  </Button>
                                ) : null}
                                <StatusBadge status={attempt.status} />
                              </div>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-slate-600">
                              {preview(getStepText(attempt) || attempt.error_json?.message || attempt.agent_snapshot?.task)}
                            </p>
                          </div>
                        ))}
                        {orderedSteps.length === 0 ? (
                          <div className="grid min-h-[360px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-sm text-slate-500">
                            No attempts have been created yet.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="artifact" className="mt-0">
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-sky-100 bg-sky-50 p-5">
                          <h3 className="text-lg font-extrabold text-[#172139]">{artifactPanelTitle}</h3>
                          <p className="mt-1 text-sm font-medium leading-6 text-[#64718a]">
                            {artifactPanelDescription}
                          </p>
                        </div>
                        {artifactPanelArtifacts.map((artifact) => (
                          <button
                            key={artifact.id}
                            onClick={() => {
                              setSelectedArtifactId(artifact.id);
                              setSelectedStepId(null);
                              setLeftTab("output");
                            }}
                            className="flex w-full items-center gap-4 rounded-2xl border bg-white p-5 text-left shadow-sm hover:border-slate-300"
                          >
                            <div className="grid size-12 place-items-center rounded-xl bg-slate-100 text-slate-600">
                              <FileText className="size-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-extrabold">{inferGoalArtifactName(run, artifact)} artifact</p>
                              <p className="mt-1 text-sm text-slate-500">Version {artifact.version} · {artifact.kind}</p>
                            </div>
                          </button>
                        ))}
                        {artifactPanelArtifacts.length === 0 ? (
                          <div className="grid min-h-[360px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-sm text-slate-500">
                            No artifacts found for this selection.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>
                  </CardContent>
              </Tabs>
            </Card>
          </section>

          <aside className="space-y-4 overflow-hidden">
            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">Final result</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {finalArtifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    onClick={() => {
                      setSelectedArtifactId(artifact.id);
                      setSelectedStepId(null);
                      setLeftTab("output");
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border p-4 text-left shadow-sm transition hover:border-slate-300",
                      (selectedArtifactId === artifact.id || (!selectedArtifactId && latestArtifact?.id === artifact.id)) ? "border-sky-200 bg-sky-50" : "bg-white",
                    )}
                  >
                    <div className="grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-600">
                      <FileText className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[17px] font-extrabold text-[#26334d]">{inferGoalArtifactName(run, artifact)} artifact</p>
                      <p className="text-xs font-medium text-slate-500">v{artifact.version} · {artifact.kind}</p>
                    </div>
                  </button>
                ))}
                {finalArtifacts.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No {finalArtifactName.toLowerCase()} artifact yet.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">Agents</CardTitle>
                <Badge variant="secondary" className="rounded-full">{doneSteps}/{latestSteps.length} done</Badge>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <button
                  onClick={() => {
                    setSelectedArtifactId(null);
                    setSelectedStepId(selectedStep?.id ?? latestSteps[0]?.id ?? null);
                    setLeftTab("output");
                  }}
                  className="w-full rounded-2xl border border-amber-200 bg-white p-4 text-left shadow-sm"
                >
                  <div className="flex gap-4">
                    <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#10182d] text-white shadow">
                      <Bot className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-[18px] font-extrabold">Parent Agent</p>
                        <StatusBadge status={run.status} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-[15px] font-medium leading-5 text-[#637089]">
                        {run.definition?.agentGraph?.parent?.task ?? "Orchestrates the run"}
                      </p>
                    </div>
                  </div>
                </button>

                {latestSteps.map((step) => {
                  const selected = selectedStepId === step.id || (!selectedStepId && selectedStep?.id === step.id);
                  const visual = agentVisual(step);
                  const Icon = visual.icon;
                  const canRetry = step.status === "failed" || step.status === "cancelled";
                  return (
                    <button
                      key={step.id}
                      onClick={() => {
                        setSelectedStepId(step.id);
                        setSelectedArtifactId(null);
                        setLeftTab("output");
                      }}
                      className={cn(
                        "w-full rounded-2xl border p-4 text-left transition",
                        selected ? "border-[#8aa0bd] bg-white shadow-sm ring-2 ring-[#8aa0bd]/40" : "border-slate-100 bg-white hover:border-slate-300",
                        step.status === "waiting_for_gate" ? "border-amber-200 bg-amber-50/70" : "",
                        step.status === "running" ? "border-yellow-200 bg-yellow-50/70" : "",
                      )}
                    >
                      <div className="flex gap-4">
                        <div className={cn("grid size-11 shrink-0 place-items-center rounded-xl", visual.className)}>
                          <Icon className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="truncate text-[18px] font-extrabold text-[#172139]">{step.agent_snapshot?.name ?? step.agent_id}</p>
                            <div className="flex shrink-0 items-center gap-2">
                              {canRetry ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`);
                                    }
                                  }}
                                  className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-xs font-bold hover:bg-slate-50"
                                >
                                  <RotateCcw className="mr-1 size-3" />
                                  Rerun
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-xs font-bold text-slate-400 opacity-70">
                                  <RotateCcw className="mr-1 size-3" />
                                  Rerun
                                </span>
                              )}
                              <StatusBadge status={step.status} />
                            </div>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[15px] font-medium leading-5 text-[#64718a]">
                            {preview(getStepText(step) || step.error_json?.message || step.agent_snapshot?.task)}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Badge variant="secondary" className="rounded-full border-0 text-xs">attempt {step.attempt}</Badge>
                            <Badge variant="secondary" className="rounded-full border-0 text-xs">
                              {step.output_json?.data?.mode ? String(step.output_json.data.mode) : "llm only"}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {latestSteps.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">Waiting for worker claim.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">From memory</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {contextEntries.map((entry) => (
                  <div key={`${entry.key}:${entry.value}`} className="rounded-2xl border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-medium">{entry.key}</p>
                      <Badge variant="secondary" className="bg-amber-50 text-amber-700">context</Badge>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{entry.value}</p>
                  </div>
                ))}
                {contextEntries.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No approved memory or submitted input yet.</p>
                ) : null}
              </CardContent>
            </Card>
          </aside>
        </div>

        <Dialog open={Boolean(memoryDetail)} onOpenChange={(open) => {
          if (!open) setMemoryDetail(null);
        }}>
          <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[860px] flex-col overflow-hidden p-0 sm:!max-w-[860px]">
            <div className="border-b px-6 py-5">
              <DialogHeader>
                <DialogTitle className="text-[21px] font-extrabold tracking-[-0.02em]">Memory details</DialogTitle>
                <DialogDescription>
                  Review the memory before deciding whether it should be included.
                </DialogDescription>
              </DialogHeader>
            </div>
            {memoryDetail ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <div className="rounded-2xl border bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Memory ID</p>
                  <p className="mt-2 break-all font-mono text-sm font-semibold text-slate-900">{memoryDetail.id}</p>
                </div>
                <div className="rounded-2xl border bg-white p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Memory content</p>
                  <div className="mt-3 whitespace-pre-wrap text-sm font-medium leading-7 text-slate-800">
                    {memoryDetail.excerpt}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Score</p>
                    <p className="mt-2 text-lg font-extrabold">{typeof memoryDetail.score === "number" ? memoryDetail.score.toFixed(4) : "n/a"}</p>
                  </div>
                  <div className="rounded-2xl border bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Confidence</p>
                    <p className="mt-2 text-lg font-extrabold">{typeof memoryDetail.confidence === "number" ? memoryDetail.confidence.toFixed(3) : "n/a"}</p>
                  </div>
                  <div className="rounded-2xl border bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Role</p>
                    <p className="mt-2 text-sm font-extrabold">{memoryDetail.evidenceRole ? label(memoryDetail.evidenceRole) : "n/a"}</p>
                  </div>
                </div>
                {memoryDetail.reason ? (
                  <div className="rounded-2xl border bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Why it matched</p>
                    <p className="mt-2 text-sm font-medium leading-6 text-slate-700">{memoryDetail.reason}</p>
                  </div>
                ) : null}
                {memoryDetail.metadata ? (
                  <div className="rounded-2xl border bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Metadata</p>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">
                      {formatJsonFull(memoryDetail.metadata)}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[1400px] flex-col overflow-hidden border-0 bg-[#f7f8fb] p-0 sm:!max-w-[1400px]">
            <div className="border-b bg-white/95 px-6 py-5 shadow-sm backdrop-blur">
              <DialogHeader className="max-w-3xl">
                <DialogTitle className="text-[22px] font-extrabold tracking-[-0.02em]">Run details</DialogTitle>
                <DialogDescription className="text-sm text-slate-600">
                  Logs, step outputs, token usage, and estimated cost for this run.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                  {label(run.status)}
                </Badge>
                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                  {latestSteps.length} steps
                </Badge>
                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                  {runLogEvents.length} events
                </Badge>
                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                  {numberFormatter.format(usageSummary.calls)} AI calls
                </Badge>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-5 px-6 py-6">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Card className="border-0 bg-white shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prompt tokens</p>
                      <p className="mt-2 text-2xl font-extrabold">{numberFormatter.format(usageSummary.promptTokens)}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-0 bg-white shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Completion tokens</p>
                      <p className="mt-2 text-2xl font-extrabold">{numberFormatter.format(usageSummary.completionTokens)}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-0 bg-white shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total tokens</p>
                      <p className="mt-2 text-2xl font-extrabold">{numberFormatter.format(usageSummary.totalTokens)}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-0 bg-white shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated cost</p>
                      <p className="mt-2 text-2xl font-extrabold">{currencyFormatter.format(usageSummary.estimatedCostUsd)}</p>
                    </CardContent>
                  </Card>
                </div>

                <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
                  <section className="space-y-4">
                    <Card className="border-0 bg-white shadow-sm">
                      <CardHeader className="border-b px-5 py-4">
                        <CardTitle className="text-lg font-extrabold">Logs</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 p-4">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Timeline</h3>
                          <div className="mt-3 space-y-3">
                            {logEntries.length > 0 ? logEntries.map((entry) => (
                              <div key={entry.id} className="rounded-2xl border bg-white p-4 shadow-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <p className="text-sm font-extrabold text-[#172139]">{entry.title}</p>
                                    <p className="text-xs text-slate-500">{formatDateTime(entry.time)}</p>
                                  </div>
                                  <StatusBadge status={entry.status} />
                                </div>
                                {entry.body ? (
                                  <pre className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{entry.body}</pre>
                                ) : null}
                              </div>
                            )) : (
                              <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No run events yet.</p>
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Step outputs</h3>
                          <div className="mt-3 space-y-3">
                            {orderedSteps.length > 0 ? orderedSteps.map((step) => (
                              <div key={step.id} className="rounded-2xl border bg-white p-4 shadow-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <p className="text-sm font-extrabold text-[#172139]">
                                      Step {step.step_index + 1} · Attempt {step.attempt}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                      {step.agent_snapshot?.name ?? step.agent_id} · {formatDateTime(step.finished_at ?? step.started_at ?? step.created_at)}
                                    </p>
                                  </div>
                                  <StatusBadge status={step.status} />
                                </div>
                                <p className="mt-3 text-sm leading-6 text-slate-600">
                                  {preview(getStepText(step) || step.error_json?.message || formatJsonPreview(step.output_json?.data), 480)}
                                </p>
                              </div>
                            )) : (
                              <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No step outputs yet.</p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {memorySearchTraces.length > 0 ? (
                      <Card className="border-0 bg-white shadow-sm">
                        <CardHeader className="border-b px-5 py-4">
                          <CardTitle className="text-lg font-extrabold">Memory search trace</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4 p-4">
                          {memorySearchTraces.map((entry, index) => (
                            <div key={`${entry.step.id}:${index}`} className="rounded-2xl border bg-slate-50 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-extrabold text-[#172139]">
                                    {entry.step.agent_snapshot?.name ?? entry.step.agent_id}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    Step {entry.step.step_index + 1} · Attempt {entry.step.attempt}
                                  </p>
                                </div>
                                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                                  {entry.validation?.confidence ?? "unknown"} confidence
                                </Badge>
                              </div>

                              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-xl border bg-white p-3">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Search log</p>
                                  <div className="mt-2 space-y-1 text-sm text-slate-700">
                                    <p>Query: {entry.query ?? "unknown"}</p>
                                    <p>Accepted: {entry.validation?.acceptedCount ?? 0} memories</p>
                                    <p>Rejected: {entry.validation?.rejectedCount ?? 0} candidates</p>
                                    {entry.validation?.noEvidenceReason ? (
                                      <p className="text-slate-500">{entry.validation.noEvidenceReason}</p>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="rounded-xl border bg-white p-3">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Retrieval trace</p>
                                  <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">
                                    {formatJsonFull({
                                      queryPlan: entry.queryPlan,
                                      retrieval: entry.retrieval,
                                      validation: entry.validation,
                                    })}
                                  </pre>
                                </div>
                              </div>

                              <div className="mt-3 rounded-xl border bg-white p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Memories found</p>
                                <div className="mt-2 space-y-2">
                                  {entry.sources.length > 0 ? entry.sources.map((source) => (
                                    <div key={source.id} className="rounded-xl border bg-slate-50 p-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="text-sm font-bold text-slate-800">{source.id}</p>
                                        <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                          {typeof source.confidence === "number" ? (
                                            <span>confidence {Math.round(source.confidence * 100)}%</span>
                                          ) : null}
                                          {source.evidenceRole ? <span>{source.evidenceRole}</span> : null}
                                        </div>
                                      </div>
                                      <p className="mt-2 max-h-[18rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{source.text}</p>
                                      {source.reason ? (
                                        <p className="mt-2 text-xs text-slate-500">{source.reason}</p>
                                      ) : null}
                                    </div>
                                  )) : (
                                    <p className="rounded-xl border border-dashed p-3 text-sm text-slate-500">No validated memories were returned.</p>
                                  )}
                                </div>
                              </div>

                              <div className="mt-3 rounded-xl border bg-white p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">All candidates</p>
                                <div className="mt-2 space-y-2">
                                  {entry.candidates.length > 0 ? entry.candidates.map((candidate) => (
                                    <div key={candidate.id} className="rounded-xl border bg-slate-50 p-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="text-sm font-bold text-slate-800">{candidate.id}</p>
                                        <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                          <span>score {candidate.score.toFixed(3)}</span>
                                          <span>{candidate.accepted ? "accepted" : "rejected"}</span>
                                          {candidate.evidenceRole ? <span>{candidate.evidenceRole}</span> : null}
                                        </div>
                                      </div>
                                      <p className="mt-2 max-h-[16rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{candidate.text}</p>
                                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                                        {typeof candidate.acceptedConfidence === "number" ? (
                                          <span>confidence {Math.round(candidate.acceptedConfidence * 100)}%</span>
                                        ) : null}
                                        {candidate.acceptedReason ? (
                                          <span>{candidate.acceptedReason}</span>
                                        ) : null}
                                      </div>
                                    </div>
                                  )) : (
                                    <p className="rounded-xl border border-dashed p-3 text-sm text-slate-500">No candidates were collected for this search.</p>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    ) : null}
                  </section>

                  <aside className="space-y-4">
                    <Card className="border-0 bg-white shadow-sm">
                      <CardHeader className="border-b px-5 py-4">
                        <CardTitle className="text-lg font-extrabold">Usage</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4 p-4">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-2xl border bg-slate-50 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated prompt tokens</p>
                            <p className="mt-2 text-xl font-extrabold">{numberFormatter.format(usageSummary.estimatedPromptTokens)}</p>
                          </div>
                          <div className="rounded-2xl border bg-slate-50 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated completion tokens</p>
                            <p className="mt-2 text-xl font-extrabold">{numberFormatter.format(usageSummary.estimatedCompletionTokens)}</p>
                          </div>
                          <div className="rounded-2xl border bg-slate-50 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estimated total tokens</p>
                            <p className="mt-2 text-xl font-extrabold">{numberFormatter.format(usageSummary.estimatedTotalTokens)}</p>
                          </div>
                          <div className="rounded-2xl border bg-slate-50 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AI calls</p>
                            <p className="mt-2 text-xl font-extrabold">{numberFormatter.format(usageSummary.calls)}</p>
                          </div>
                        </div>

                        <div className="rounded-2xl border bg-slate-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Models</p>
                          <div className="mt-3 space-y-2">
                            {usageModels.length > 0 ? usageModels.map(([model, count]) => (
                              <div key={model} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 shadow-sm">
                                <span className="truncate text-sm font-semibold text-slate-700">{model}</span>
                                <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                                  {numberFormatter.format(count)}
                                </Badge>
                              </div>
                            )) : (
                              <p className="text-sm text-slate-500">No model usage recorded.</p>
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border bg-slate-50 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Usage by step</p>
                          <div className="mt-3 space-y-2">
                            {stepUsageRows.filter((row) => row.usage.calls > 0 || row.usage.promptTokens > 0 || row.usage.completionTokens > 0).length > 0 ? stepUsageRows
                              .filter((row) => row.usage.calls > 0 || row.usage.promptTokens > 0 || row.usage.completionTokens > 0)
                              .map((row) => (
                                <div key={row.step.id} className="rounded-xl bg-white p-3 shadow-sm">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="truncate text-sm font-semibold text-slate-700">
                                      {row.step.agent_snapshot?.name ?? row.step.agent_id}
                                    </p>
                                    <Badge variant="secondary" className="rounded-full bg-slate-100 text-slate-700">
                                      attempt {row.step.attempt}
                                    </Badge>
                                  </div>
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
                                    <span>Prompt: {numberFormatter.format(row.usage.promptTokens)}</span>
                                    <span>Completion: {numberFormatter.format(row.usage.completionTokens)}</span>
                                    <span>Total: {numberFormatter.format(row.usage.totalTokens)}</span>
                                    <span>Cost: {currencyFormatter.format(row.usage.estimatedCostUsd)}</span>
                                  </div>
                                </div>
                              )) : (
                              <p className="text-sm text-slate-500">No LLM usage recorded.</p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </aside>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}

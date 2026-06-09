"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Bot,
  Check,
  ChevronRight,
  Code,
  Columns2,
  Database,
  FileText,
  Info,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Target,
  X,
  Brain,
  Puzzle,
} from "lucide-react";

import {
  EditorialDialogBody,
  EditorialDialogHeader,
  EditorialEmpty,
  EditorialField,
  EditorialListRow,
  EditorialMetaTag,
  EditorialPanel,
  EditorialStat,
  EditorialStatGrid,
  editorialDialogContentClass,
} from "./components/editorial-run-ui";
import {
  ChildAgentRow,
  ChildAgentsHeader,
  ChildAgentsShell,
  ParentAgentRow,
  AgentIconBox,
  AttemptChip,
  LegendaryToolBadge,
  formatSupervisorDisplayName,
  formatWorkerDisplayName,
  resolveChildAgentIcon,
  resolveStepToolRefs,
  workerSlotLabel,
} from "./components/agent-panel-ui";
import { EditorialActionButton } from "./components/glyph-icons";
import {
  AgentProgressPips,
  DraftReviewWorkspace,
  MissingInputWorkspace,
  gateStatusImperative,
  readGateAgentOutput,
  resolveInputFieldLabel,
  resolveInputFieldPlaceholder,
} from "./components/gate-workspace-ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
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
  agent_snapshot: {
    id?: string;
    name?: string;
    task?: string;
    tools?: Array<{ ref: string }>;
    gate?: { type?: Gate["gate_type"]; question?: string };
  };
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
    inputsRequired?: string[];
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name?: string; task?: string; tools?: Array<{ ref: string }> }>;
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
  if (value === "waiting_for_gate") return "Paused · Needs Approval";
  if (value === "waiting_for_approval") return "Paused · Needs Approval";
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

function StatusBadge({ status }: { status: string }) {
  const tone = status === "succeeded" || status === "approved" || status === "submitted"
    ? "neutral"
    : status === "failed" || status === "blocked" || status === "cancelled" || status === "rejected"
      ? "red"
      : status === "waiting_for_gate" || status === "pending"
        ? "amber"
        : status === "running"
          ? "blue"
          : "neutral";
  return <EditorialMetaTag tone={tone}>{label(status)}</EditorialMetaTag>;
}

function RunStatusPill({ status }: { status: string }) {
  const tone = status === "succeeded" || status === "approved"
    ? "border-[#86c8a8] bg-[#edf8f2] text-[#166534]"
    : status === "failed" || status === "blocked" || status === "cancelled" || status === "rejected"
      ? "border-[#d9a3a3] bg-[#fdf2f2] text-[#991b1b]"
      : status === "waiting_for_gate" || status === "pending"
        ? "border-[#9bb8d9] bg-[#edf3fb] text-[#1e4070]"
        : status === "running"
          ? "border-[#b8c9dc] bg-[#f0f4f9] text-[#334155]"
          : "border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]";
  return (
    <span
      className={cn("inline-flex items-center border px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase", tone)}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {label(status)}
    </span>
  );
}

function EditorialToolbarButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  danger?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "grid size-9 place-items-center border border-[#d1d5db] bg-white text-[#6b7280] transition-colors hover:bg-[#fafafa] hover:text-[#111827] disabled:opacity-50",
            danger && "hover:border-[#d9a3a3] hover:text-[#991b1b]",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

function getStepText(step: StepAttempt | null | undefined) {
  return step?.output_json?.text?.trim() ?? "";
}

function getStepDisplayContent(step: StepAttempt | null | undefined): string {
  const text = getStepText(step);
  if (text) return text;
  const error = step?.error_json?.message?.trim();
  if (error) return error;
  if (step?.status === "waiting_for_gate") {
    return "This agent finished its run and is waiting for your approval.";
  }
  if (step?.status === "running") return "This agent is still running.";
  if (step?.status === "queued") return "This agent has not started yet.";
  const dataPreview = formatJsonPreview(step?.output_json?.data, 2_400);
  if (dataPreview && dataPreview !== "{}" && dataPreview !== "null") return dataPreview;
  return "";
}

function gateTypeShortLabel(gateType: Gate["gate_type"]) {
  if (gateType === "memory_confirmation") return "memory review";
  if (gateType === "missing_input") return "missing input";
  if (gateType === "draft_review") return "draft review";
  return "pre-send check";
}

function buildParentAgentNarrative({
  run,
  parentRunPhase,
  currentStep,
  currentStepLabel,
  pendingGate,
  gateUiMode,
  latestSteps,
  doneSteps,
}: {
  run: RunProjection;
  parentRunPhase: ParentRunPhase;
  currentStep: StepAttempt | null;
  currentStepLabel: string;
  pendingGate: Gate | null;
  gateUiMode: Gate["gate_type"] | null;
  latestSteps: StepAttempt[];
  doneSteps: number;
}) {
  const parentName = formatSupervisorDisplayName(run.definition?.agentGraph?.parent?.name?.trim() || "Tallei Agent");
  const parentTask = run.definition?.agentGraph?.parent?.task?.trim()
    || "Dispatches agents in order, checks task completion, and routes outputs between slots.";
  const goal = run.definition?.goal?.trim();
  const workerNames = latestSteps
    .map((step) => step.agent_snapshot?.name ?? step.agent_id)
    .filter((name, index, array) => array.indexOf(name) === index);
  const roster = workerNames.length > 0
    ? `Queue: ${workerNames.map(formatWorkerDisplayName).join(" → ")}.`
    : "Queue: waiting for agents.";
  const orchestration = workerNames.length > 0
    ? `Coordinates ${workerNames.length} agents — assigns each slot, validates output, passes deliverables downstream, and holds at approval gates until you respond.`
    : "Coordinates the job — assigns agents, validates output, and holds at gates until you respond.";
  const upNextWorker = pendingGate
    ? getNextWorkerName(run, latestSteps)
    : currentStep
      ? latestSteps.find((step) => step.step_index === currentStep.step_index + 1)?.agent_snapshot?.name
        ?? latestSteps.find((step) => step.step_index === currentStep.step_index + 1)?.agent_id
        ?? null
      : latestSteps[0]?.agent_snapshot?.name ?? latestSteps[0]?.agent_id ?? null;
  const upNextWorkerLabel = upNextWorker ? formatWorkerDisplayName(upNextWorker) : null;

  let statusLine = "";
  if (parentRunPhase === "paused" && pendingGate && gateUiMode) {
    const gateHint = gateUiMode === "memory_confirmation"
      ? "Select which memories the next agent may use."
      : gateUiMode === "missing_input"
        ? "Provide the missing input in the workspace."
        : gateUiMode === "draft_review"
          ? "Review the draft in the workspace, then approve or request changes."
          : "Confirm in the workspace before the run continues.";
    statusLine = `Paused at ${currentStepLabel.toLowerCase()} for ${gateTypeShortLabel(gateUiMode)}. ${gateHint}${upNextWorkerLabel ? ` After approval, ${upNextWorkerLabel} is next.` : ""}`;
  } else if (parentRunPhase === "running" && currentStep) {
    statusLine = `Live: ${currentStepLabel.toLowerCase()}. ${doneSteps} of ${latestSteps.length} agents complete${upNextWorkerLabel ? `; next is ${upNextWorkerLabel}` : "; final agent in queue"}.`;
  } else if (parentRunPhase === "blocked") {
    statusLine = `Job blocked${currentStep ? ` at ${currentStepLabel.toLowerCase()}` : ""}. Fix the failed agent or rejected gate, then rerun to resume the queue.`;
  } else if (parentRunPhase === "done") {
    statusLine = `All ${latestSteps.length} agents finished. The orchestrator has routed final outputs for this job.`;
  } else {
    statusLine = `Spinning up${currentStep ? ` — next slot is ${currentStepLabel.toLowerCase()}` : ""}.`;
  }

  return {
    parentName,
    parentTask,
    goalLine: goal ? `Goal: ${goal}` : null,
    orchestration,
    roster,
    statusLine,
  };
}

function stripDisplayEmoji(value: string) {
  return value.replace(/\p{Extended_Pictographic}/gu, "").replace(/\s{2,}/g, " ").trim();
}

type StepRowPhase =
  | "current_gate"
  | "current_running"
  | "running"
  | "done"
  | "queued"
  | "failed"
  | "idle";

type ParentRunPhase = "paused" | "running" | "blocked" | "done" | "idle";

function resolveCurrentStep(
  latestSteps: StepAttempt[],
  pendingGate: Gate | null,
  currentStepIndex: number | null | undefined,
): StepAttempt | null {
  const gateStep = latestSteps.find((step) => step.status === "waiting_for_gate");
  if (pendingGate && gateStep) return gateStep;

  const runningStep = latestSteps.find((step) => step.status === "running");
  if (runningStep) return runningStep;

  if (typeof currentStepIndex === "number") {
    const indexed = latestSteps.find((step) => step.step_index === currentStepIndex);
    if (indexed && indexed.status !== "succeeded") return indexed;
  }

  return latestSteps.find((step) => (
    step.status !== "succeeded"
    && step.status !== "cancelled"
    && step.status !== "approved"
  )) ?? null;
}

function resolveStepRowPhase(
  step: StepAttempt,
  currentStep: StepAttempt | null,
  pendingGate: Gate | null,
): StepRowPhase {
  const isCurrent = currentStep?.id === step.id;
  if (isCurrent && pendingGate && step.status === "waiting_for_gate") return "current_gate";
  if (isCurrent && step.status === "running") return "current_running";
  if (step.status === "running") return "running";
  if (step.status === "failed" || step.status === "cancelled") return "failed";
  if (step.status === "succeeded" || step.status === "approved") return "done";
  if (currentStep && step.step_index > currentStep.step_index) return "queued";
  if (!step.started_at) return "queued";
  return "idle";
}

function resolveParentRunPhase(
  runStatus: string,
  pendingGate: Gate | null,
  hasFailure: boolean,
): ParentRunPhase {
  if (pendingGate) return "paused";
  if (hasFailure || runStatus === "blocked" || runStatus === "failed" || runStatus === "cancelled") return "blocked";
  if (runStatus === "running" || runStatus === "waiting_for_gate") return "running";
  if (runStatus === "succeeded") return "done";
  return "idle";
}

function EditorialSidebarPanel({
  title,
  icon: Icon,
  meta,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-[#d1d5db] bg-white">
      <header className="flex items-center justify-between border-b border-[#e5e7eb] bg-[#fafafa] px-5 py-3.5">
        <h2
          className="flex items-center gap-2 text-[14px] font-bold tracking-[-0.02em] text-[#111827]"
          style={{ fontFamily: "var(--font-title)" }}
        >
          {Icon ? <Icon className="size-4 text-[#6b7280]" /> : null}
          {title}
        </h2>
        {meta}
      </header>
      {children}
    </section>
  );
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

function memoryItemTitle(item: MemoryGateItem) {
  const meta = item.metadata;
  if (meta && typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  if (meta && typeof meta.key === "string" && meta.key.trim()) return titleCase(meta.key.trim());
  const summary = memoryItemSummary(item);
  const words = summary.split(" ").slice(0, 8).join(" ");
  return words.length < summary.length ? `${words}…` : words;
}

function memoryItemMeta(item: MemoryGateItem) {
  const shortId = item.id.length > 8 ? `${item.id.slice(0, 8)}…` : item.id;
  const parts = [shortId];
  if (item.evidenceRole) parts.push(label(item.evidenceRole));
  if (typeof item.confidence === "number") parts.push(`${Math.round(item.confidence * 100)}% match`);
  else if (typeof item.score === "number") parts.push(`score ${item.score.toFixed(2)}`);
  return parts.join(" · ");
}

function gateWorkspaceTitle(gateType: Gate["gate_type"]) {
  if (gateType === "memory_confirmation") return "Select memories";
  if (gateType === "missing_input") return "Input required";
  if (gateType === "draft_review") return "Review the draft";
  return "Approve to send";
}

function gateWorkspaceSubtitle(gate: Gate, uiMode: Gate["gate_type"]) {
  if (uiMode === "memory_confirmation") return "Choose what the next agent can use.";
  if (uiMode === "missing_input") {
    return "Paste the missing input below, then submit to continue the run.";
  }
  if (uiMode === "draft_review") return "Review the draft below. Approve to continue, edit to revise, or reject to stop.";
  return gate.question ?? "Confirm before this run sends or publishes.";
}

function isInputValidationAgentSnapshot(agent: StepAttempt["agent_snapshot"] | undefined): boolean {
  const label = `${agent?.id ?? ""} ${agent?.name ?? ""}`.toLowerCase();
  return label.includes("validator") || label.includes("input_gate") || label.includes("input checker");
}

function runInputsSatisfied(
  definition: RunProjection["definition"],
  context: Record<string, unknown> | undefined,
): boolean {
  const keys = definition?.inputsRequired ?? [];
  if (keys.length === 0) return true;
  const inputs = context?.inputs && typeof context.inputs === "object" && !Array.isArray(context.inputs)
    ? context.inputs as Record<string, unknown>
    : {};
  return keys.every((key) => typeof inputs[key] === "string" && inputs[key].trim());
}

function readGateBlockers(gate: Gate): string[] {
  const result = gate.payload_json?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const goalEval = (result as Record<string, unknown>).goalEval;
  if (!goalEval || typeof goalEval !== "object" || Array.isArray(goalEval)) return [];
  const blockers = (goalEval as Record<string, unknown>).blockers;
  return Array.isArray(blockers) ? blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
}

function resolveGateUiContract(input: {
  gate: Gate;
  gateStep: StepAttempt | null;
  run: RunProjection;
}): Gate["gate_type"] {
  const { gate, gateStep, run } = input;
  if (gate.gate_type !== "missing_input") return gate.gate_type;

  const configuredGate = gateStep?.agent_snapshot?.gate?.type;
  const blockers = readGateBlockers(gate);
  const inputAgent = isInputValidationAgentSnapshot(gateStep?.agent_snapshot);
  const inputsReady = runInputsSatisfied(run.definition, run.context);

  if (blockers.includes("placeholder_detected") && !inputAgent) {
    return configuredGate === "pre_send" ? "pre_send" : "draft_review";
  }
  if (/placeholder|unfilled template/i.test(gate.question) && !inputAgent) {
    return configuredGate === "pre_send" ? "pre_send" : "draft_review";
  }
  if (!inputAgent && inputsReady) {
    return configuredGate === "pre_send" ? "pre_send" : "draft_review";
  }
  if (!inputAgent && configuredGate && configuredGate !== "missing_input") {
    return configuredGate;
  }
  return "missing_input";
}

function getNextWorkerName(
  run: RunProjection | null,
  latestSteps: StepAttempt[],
): string | null {
  const gateStep = latestSteps.find((step) => step.status === "waiting_for_gate");
  if (gateStep) {
    const next = latestSteps.find((step) => step.step_index === gateStep.step_index + 1);
    if (next) return next.agent_snapshot?.name ?? next.agent_id;
  }
  const children = run?.definition?.agentGraph?.children ?? [];
  const completed = latestSteps.filter((step) => step.status === "succeeded").length;
  const child = children[completed] ?? children[completed - 1];
  return child?.name ?? child?.id ?? null;
}

function buildRunningStages(activeStageName: string) {
  return [activeStageName, "Processing agent output", "Updating job state"].filter(
    (value, index, array) => array.indexOf(value) === index,
  );
}

const statusBandTexture = [
  "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(37,99,235,0.028) 11px, rgba(37,99,235,0.028) 12px)",
  "repeating-linear-gradient(90deg, transparent, transparent 11px, rgba(37,99,235,0.02) 11px, rgba(37,99,235,0.02) 12px)",
  "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(59,130,246,0.07), transparent 55%)",
].join(", ");

const failureBandTexture = [
  "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(220,38,38,0.028) 11px, rgba(220,38,38,0.028) 12px)",
  "repeating-linear-gradient(90deg, transparent, transparent 11px, rgba(220,38,38,0.02) 11px, rgba(220,38,38,0.02) 12px)",
  "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(248,113,113,0.08), transparent 55%)",
].join(", ");

function gateTypeStamp(gateType: Gate["gate_type"]) {
  if (gateType === "memory_confirmation") return { tag: "Approval", name: "Memory" };
  if (gateType === "missing_input") return { tag: "Input", name: "Required" };
  if (gateType === "draft_review") return { tag: "Review", name: "Draft" };
  return { tag: "Send", name: "Final check" };
}

function RejectionTypeStamp({ subject = "Gate" }: { subject?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="shrink-0 border border-[#d9a3a3] bg-white/70 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-[#991b1b] uppercase"
        style={{ fontFamily: "var(--font-title)" }}
      >
        Rejected
      </span>
      <span className="shrink-0 text-[15px] text-[#d9a3a3]">/</span>
      <span
        className="truncate text-[17px] font-semibold tracking-[-0.02em] text-[#7f1d1d]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {subject}
      </span>
    </div>
  );
}

function FailureTypeStamp({ agentName }: { agentName: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="shrink-0 border border-[#d9a3a3] bg-white/70 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-[#991b1b] uppercase"
        style={{ fontFamily: "var(--font-title)" }}
      >
        Failed
      </span>
      <span className="shrink-0 text-[15px] text-[#d9a3a3]">/</span>
      <span
        className="truncate text-[17px] font-semibold tracking-[-0.02em] text-[#7f1d1d]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {agentName}
      </span>
    </div>
  );
}

function GateTypeStamp({ gateType }: { gateType: Gate["gate_type"] }) {
  const stamp = gateTypeStamp(gateType);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="shrink-0 border border-[#9bb8d9] bg-white/70 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-[#2d5a87] uppercase"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {stamp.tag}
      </span>
      <span className="shrink-0 text-[15px] text-[#9bb8d9]">/</span>
      <span
        className="truncate text-[17px] font-semibold tracking-[-0.02em] text-[#1e4070]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {stamp.name}
      </span>
    </div>
  );
}

function EditorialWorkspaceShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col border border-[#d1d5db] bg-white", className)}>
      {children}
    </div>
  );
}

function LeftPanelLoader() {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#f8fafc] p-4">
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 left-[-40%] w-[60%] bg-gradient-to-r from-transparent via-white/50 to-transparent"
          style={{ animation: "left-panel-shimmer 1.8s ease-in-out infinite" }}
        />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-[14px] border border-[#d1d5db] bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3 border-b border-[#e5e7eb] pb-3">
          <div className="size-8 rounded-md bg-[#edf3fb]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded-full bg-[#e5e7eb]" />
            <div className="h-2.5 w-1/2 rounded-full bg-[#eef2ff]" />
          </div>
          <div className="h-6 w-14 rounded-full bg-[#eef2ff]" />
        </div>

        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
          <div className="flex min-h-0 w-[42%] flex-col gap-3 overflow-hidden rounded-[12px] border border-[#e5e7eb] bg-[#fafafa] p-3">
            <div className="h-4 w-1/2 rounded-full bg-[#e5e7eb]" />
            <div className="h-3 w-full rounded-full bg-[#eef2ff]" />
            <div className="h-3 w-5/6 rounded-full bg-[#eef2ff]" />
            <div className="mt-1 flex-1 rounded-[10px] border border-[#e5e7eb] bg-white" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-[12px] border border-[#e5e7eb] bg-[#fafafa] p-3">
            <div className="h-4 w-2/5 rounded-full bg-[#e5e7eb]" />
            <div className="h-3 w-4/5 rounded-full bg-[#eef2ff]" />
            <div className="h-3 w-2/3 rounded-full bg-[#eef2ff]" />
            <div className="flex-1 rounded-[10px] border border-[#e5e7eb] bg-white" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-[#e5e7eb] pt-3">
          <div className="h-10 rounded-[10px] bg-[#eef2ff]" />
          <div className="h-10 rounded-[10px] bg-[#eef2ff]" />
        </div>
      </div>

      <style jsx global>{`
        @keyframes left-panel-shimmer {
          0% { transform: translateX(-30%); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translateX(260%); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function RunningSlotText({ stages }: { stages: string[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (stages.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % stages.length);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [stages]);

  const stage = stages[index] ?? stages[0] ?? "";

  return (
    <span className="block min-h-[22px] overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.span
          key={stage}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          className="block truncate text-[15px] font-medium text-[#334155]"
          style={{ fontFamily: "var(--font-fustat)" }}
        >
          {stage}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function RunStatusBand({
  gateResolvedFlash,
  transitioningAfterGate,
  pendingGate,
  gateUiMode,
  runStatus,
  failureStep,
  failureMessage,
  isGateRejected,
  activeStageName,
  busy,
  approveLabel,
  approveDisabled,
  onApprove,
  onReject,
  onRerun,
}: {
  gateResolvedFlash: boolean;
  transitioningAfterGate: boolean;
  pendingGate: Gate | null;
  gateUiMode: Gate["gate_type"] | null;
  runStatus: string;
  failureStep: StepAttempt | null;
  failureMessage: string | null;
  isGateRejected: boolean;
  activeStageName: string;
  busy: boolean;
  approveLabel: string;
  approveDisabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRerun: () => void;
}) {
  const runningStages = useMemo(() => buildRunningStages(activeStageName), [activeStageName]);
  const isSucceeded = runStatus === "succeeded";
  const showFailure = Boolean((failureStep || failureMessage) && !pendingGate && !gateResolvedFlash && !transitioningAfterGate);
  const bandHeight = (pendingGate && !gateResolvedFlash) || showFailure ? 80 : 64;

  const shellClass = gateResolvedFlash
    ? "border-[#86c8a8] bg-[#edf8f2]"
    : isSucceeded
      ? "border-[#86c8a8] bg-[#edf8f2]"
    : transitioningAfterGate
      ? "border-[#b8c9dc] bg-[#f0f4f9]"
    : pendingGate
      ? "border-[#9bb8d9] bg-[#edf3fb]"
      : showFailure
        ? "border-[#d9a3a3] bg-[#fdf2f2]"
        : "border-[#b8c9dc] bg-[#f0f4f9]";

  const shellTexture = gateResolvedFlash
    ? [
        "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(5,150,105,0.028) 11px, rgba(5,150,105,0.028) 12px)",
        "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(16,185,129,0.07), transparent 55%)",
      ].join(", ")
    : isSucceeded
      ? [
          "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(5,150,105,0.028) 11px, rgba(5,150,105,0.028) 12px)",
          "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(16,185,129,0.06), transparent 55%)",
        ].join(", ")
    : pendingGate
      ? statusBandTexture
      : transitioningAfterGate
        ? [
            "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(100,116,139,0.025) 11px, rgba(100,116,139,0.025) 12px)",
            "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(148,163,184,0.05), transparent 55%)",
          ].join(", ")
      : showFailure
        ? failureBandTexture
        : [
            "repeating-linear-gradient(0deg, transparent, transparent 11px, rgba(100,116,139,0.025) 11px, rgba(100,116,139,0.025) 12px)",
            "radial-gradient(ellipse 120% 80% at 0% 50%, rgba(148,163,184,0.06), transparent 55%)",
          ].join(", ");

  const failureSubtitle = preview(
    failureMessage ?? failureStep?.error_json?.message ?? "This step failed and needs a rerun.",
    120,
  );

  return (
    <motion.div
      animate={{ height: bandHeight }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className={cn("relative mb-5 flex overflow-hidden border", shellClass)}
      style={{ backgroundImage: shellTexture }}
    >
      <AnimatePresence mode="wait">
        {gateResolvedFlash ? (
          <motion.div
            key="flash"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex min-w-0 flex-1 items-center justify-between gap-4 px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0">
              <p
                className="text-[11px] font-semibold tracking-[0.1em] text-[#3d8b6a] uppercase"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Resolved
              </p>
              <p className="truncate text-[15px] font-medium text-[#14532d]">Continuing — {activeStageName}</p>
            </div>
          </motion.div>
        ) : isSucceeded ? (
          <motion.div
            key="complete"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex min-w-0 flex-1 items-center px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0 flex-1">
              <p
                className="text-[11px] font-semibold tracking-[0.1em] text-[#3d8b6a] uppercase"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Complete
              </p>
              <p className="truncate text-[15px] font-medium text-[#14532d]">
                Job finished. Final artifact is ready.
              </p>
            </div>
          </motion.div>
        ) : transitioningAfterGate ? (
          <motion.div
            key="transition"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex min-w-0 flex-1 items-center justify-between gap-4 px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0">
              <p
                className="text-[11px] font-semibold tracking-[0.1em] text-[#64748b] uppercase"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Working
              </p>
              <p className="truncate text-[15px] font-medium text-[#334155]">
                Approval received. The next step is still running.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[#64748b]">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-[13px] font-medium">Processing</span>
            </div>
          </motion.div>
        ) : pendingGate ? (
          <motion.div
            key="gate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex min-w-0 flex-1 items-center justify-between gap-5 px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0 flex-1">
              <GateTypeStamp gateType={gateUiMode ?? pendingGate.gate_type} />
              <p className="mt-1 truncate text-[14px] font-semibold text-[#1e4070]">
                {gateUiMode ? gateStatusImperative(gateUiMode) : "Review and decide how to continue"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <EditorialActionButton
                label="Reject"
                glyph="reject"
                variant="secondary"
                onClick={onReject}
                disabled={busy}
                className="px-4 text-[14px]"
              />
              {gateUiMode !== "missing_input" ? (
                <EditorialActionButton
                  label={approveLabel}
                  glyph={approveLabel.startsWith("Submit") ? "submit" : "approve"}
                  variant="primary"
                  onClick={onApprove}
                  disabled={busy || approveDisabled}
                  className="px-5 text-[14px]"
                />
              ) : null}
            </div>
          </motion.div>
        ) : showFailure ? (
          <motion.div
            key="failure"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex min-w-0 flex-1 items-center justify-between gap-5 px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0 flex-1">
              {isGateRejected ? (
                <RejectionTypeStamp />
              ) : (
                <FailureTypeStamp agentName={formatWorkerDisplayName(failureStep?.agent_snapshot?.name ?? failureStep?.agent_id ?? "Agent")} />
              )}
              <p className="mt-1 truncate text-[14px] font-medium text-[#991b1b]">{failureSubtitle}</p>
            </div>
            {failureStep ? (
              <EditorialActionButton
                label="Rerun"
                glyph="rerun"
                variant="danger"
                onClick={onRerun}
                disabled={busy}
                className="px-6 text-[14px]"
              />
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="running"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex min-w-0 flex-1 items-center px-6"
            style={{ fontFamily: "var(--font-fustat)" }}
          >
            <div className="min-w-0 flex-1">
              <p
                className="text-[11px] font-semibold tracking-[0.1em] text-[#64748b] uppercase"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Running
              </p>
              <RunningSlotText stages={runningStages} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function StepStatusBadge({ status, needsAttention }: { status: string; needsAttention?: boolean }) {
  if (needsAttention) {
    return <EditorialMetaTag tone="blue">Needs you</EditorialMetaTag>;
  }
  if (status === "succeeded" || status === "approved" || status === "submitted") {
    return <EditorialMetaTag tone="neutral">Succeeded</EditorialMetaTag>;
  }
  if (status === "failed" || status === "blocked" || status === "cancelled" || status === "rejected") {
    return <EditorialMetaTag tone="red">Failed</EditorialMetaTag>;
  }
  if (status === "waiting_for_gate" || status === "pending") {
    return <EditorialMetaTag tone="amber">Waiting</EditorialMetaTag>;
  }
  if (status === "running") {
    return <EditorialMetaTag tone="blue">Running</EditorialMetaTag>;
  }
  return <EditorialMetaTag>{label(status)}</EditorialMetaTag>;
}

function MemoryEditCanvas({
  gateId,
  items,
  selectedIds,
  onToggle,
  onInspect,
}: {
  gateId: string;
  items: MemoryGateItem[];
  selectedIds: Set<string>;
  onToggle: (gateId: string, memoryId: string, checked: boolean) => void;
  onInspect: (item: MemoryGateItem) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-[#9ca3af]">No validated memories to review.</p>
    );
  }

  return (
    <div>
      {items.map((item) => {
        const selected = selectedIds.has(item.id);
        const title = memoryItemTitle(item);
        const summary = memoryItemSummary(item);
        const meta = memoryItemMeta(item);
        return (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-4 border-b border-[#e5e7eb] px-7 py-4 transition-colors hover:bg-[#fafafa]",
              selected && "bg-[#f9fafb] ring-1 ring-inset ring-[#111827]/10",
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onToggle(gateId, item.id, checked === true)}
              aria-label={`Include memory ${title}`}
              className="mt-1 rounded-[2px]"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#111827]">{title}</p>
              <p className="mt-1 line-clamp-2 text-[14px] leading-6 text-[#4b5563]">{summary}</p>
              <p className="mt-1.5 font-mono text-[12px] text-[#9ca3af]">{meta}</p>
            </div>
            <button
              type="button"
              onClick={() => onInspect(item)}
              className="shrink-0 pt-0.5 text-[13px] text-[#6b7280] underline-offset-2 hover:text-[#111827] hover:underline"
            >
              View →
            </button>
          </div>
        );
      })}
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
  const [gateResolvedFlash, setGateResolvedFlash] = useState(false);
  const [gateTransitionStepId, setGateTransitionStepId] = useState<string | null>(null);
  const [prevGateId, setPrevGateId] = useState<string | null>(null);
  const [agentInfoStepId, setAgentInfoStepId] = useState<string | null>(null);
  const showHiringToast = useCallback((roleName: string) => {
    toast.success("Hiring coming soon", {
      description: `You’ll be able to hire and fine-tune ${roleName} here.`,
    });
  }, []);

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
  const gateStep = useMemo(
    () => latestSteps.find((step) => step.status === "waiting_for_gate") ?? null,
    [latestSteps],
  );
  const gateUiMode = useMemo(
    () => (run && pendingGate ? resolveGateUiContract({ gate: pendingGate, gateStep, run }) : null),
    [gateStep, pendingGate, run],
  );
  const rejectedGate = useMemo(
    () => [...(run?.gates ?? [])].reverse().find((gate) => gate.status === "rejected") ?? null,
    [run?.gates],
  );
  const runHasTerminalFailure = run?.status === "failed" || run?.status === "blocked" || run?.status === "cancelled";
  const failureRetryTarget = useMemo(() => {
    if (!runHasTerminalFailure) return null;
    const failedLatest = [...latestSteps]
      .filter((step) => step.status === "failed" || step.status === "cancelled")
      .sort((left, right) => right.step_index - left.step_index)[0];
    if (failedLatest) return failedLatest;
    return [...orderedSteps]
      .filter((step) => step.status === "failed" || step.status === "cancelled")
      .sort((left, right) => right.step_index - left.step_index)[0] ?? null;
  }, [latestSteps, orderedSteps, runHasTerminalFailure]);
  const isGateRejected = useMemo(() => {
    const message = `${error ?? ""} ${run?.error_json?.message ?? ""}`.toLowerCase();
    return message.includes("gate rejected") || Boolean(rejectedGate);
  }, [error, rejectedGate, run?.error_json?.message]);
  const failureMessage = useMemo(() => {
    if (error) return error;
    if (failureRetryTarget?.error_json?.message) return failureRetryTarget.error_json.message;
    if (runHasTerminalFailure && run?.error_json?.message) return run.error_json.message;
    return null;
  }, [error, failureRetryTarget, run?.error_json?.message, runHasTerminalFailure]);

  useEffect(() => {
    if (prevGateId && !pendingGate) {
      setGateResolvedFlash(true);
      const timer = window.setTimeout(() => setGateResolvedFlash(false), 400);
      return () => window.clearTimeout(timer);
    }
    setPrevGateId(pendingGate?.id ?? null);
  }, [pendingGate, prevGateId]);

  const currentStep = useMemo(
    () => resolveCurrentStep(latestSteps, pendingGate, run?.current_step_index),
    [latestSteps, pendingGate, run?.current_step_index],
  );
  const activelyExecutingAfterGate = Boolean(
    !pendingGate &&
      run?.status === "running" &&
      currentStep?.status === "running" &&
      finalArtifacts.length > 0,
  );
  const transitioningAfterGate = Boolean(
    !pendingGate &&
      !terminalStatuses.has(run?.status ?? "idle") &&
      (gateTransitionStepId || activelyExecutingAfterGate),
  );
  const currentStepLabel = useMemo(() => {
    if (!currentStep) return "Starting run";
    const name = currentStep.agent_snapshot?.name ?? currentStep.agent_id;
    return workerSlotLabel(currentStep.step_index, name);
  }, [currentStep]);
  const agentPanelStatusLabel = run?.status === "succeeded"
    ? "Complete"
    : run?.status === "blocked" || run?.status === "failed" || run?.status === "cancelled"
      ? "Needs attention"
      : currentStepLabel;
  useEffect(() => {
    if (!gateTransitionStepId) return;
    if (!run || terminalStatuses.has(run.status) || pendingGate) {
      setGateTransitionStepId(null);
    }
  }, [gateTransitionStepId, pendingGate, run]);
  const doneSteps = latestSteps.filter((step) => step.status === "succeeded").length;
  const nextWorkerName = useMemo(
    () => {
      const raw = pendingGate ? getNextWorkerName(run, latestSteps) : null;
      return raw ? formatWorkerDisplayName(raw) : null;
    },
    [latestSteps, pendingGate, run],
  );
  const parentRunPhase = useMemo(
    () => resolveParentRunPhase(run?.status ?? "idle", pendingGate, Boolean(failureRetryTarget) && !transitioningAfterGate),
    [failureRetryTarget, pendingGate, run?.status, transitioningAfterGate],
  );
  const parentAgentNarrative = useMemo(() => {
    if (!run) {
      return {
        parentName: "Tallei Agent",
        parentTask: "Coordinates agents on this job.",
        goalLine: null,
        orchestration: "",
        roster: "",
        statusLine: "",
      };
    }
    return buildParentAgentNarrative({
      run,
      parentRunPhase,
      currentStep,
      currentStepLabel,
      pendingGate,
      gateUiMode,
      latestSteps,
      doneSteps,
    });
  }, [currentStep, currentStepLabel, doneSteps, gateUiMode, latestSteps, parentRunPhase, pendingGate, run]);
  const activeStageName = useMemo(() => {
    if (currentStep) {
      return formatWorkerDisplayName(currentStep.agent_snapshot?.name ?? `Slot ${currentStep.step_index + 1}`);
    }
    if (pendingGate) return pendingGate.gate_type;
    return "Initializing";
  }, [currentStep, pendingGate]);
  const memoryGateItems = useMemo(
    () => gateUiMode === "memory_confirmation" && pendingGate ? readMemoryGateItems(pendingGate) : [],
    [gateUiMode, pendingGate],
  );
  const selectedMemoryIds = useMemo(
    () => new Set(memorySelections[pendingGate?.id ?? ""] ?? memoryGateItems.filter((item) => item.include !== false).map((item) => item.id)),
    [memoryGateItems, memorySelections, pendingGate?.id],
  );
  const missingInputGateActive = Boolean(pendingGate && gateUiMode === "missing_input");
  const selectedStep = useMemo(() => {
    if (selectedStepId) return orderedSteps.find((step) => step.id === selectedStepId) ?? null;
    if (missingInputGateActive) return null;
    if (currentStep) return orderedSteps.find((step) => step.id === currentStep.id) ?? currentStep;
    return [...orderedSteps].reverse().find((step) => getStepText(step) || step.status === "waiting_for_gate" || step.status === "running") ?? null;
  }, [currentStep, missingInputGateActive, orderedSteps, selectedStepId]);
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
  const showMissingInputWorkspace = Boolean(pendingGate && gateUiMode === "missing_input");
  const showGateWorkspace = Boolean(
    pendingGate && gateUiMode && gateUiMode !== "missing_input" && !selectedStepId,
  );
  const centerTitle = inspectingAgentOutput
    ? `${formatWorkerDisplayName(selectedStep?.agent_snapshot?.name ?? selectedStep?.agent_id ?? "Agent")} output`
    : missingInputGateActive && !selectedStepId
      ? "Agent outputs"
      : activeArtifact
        ? `${finalArtifactName} artifact`
        : `${finalArtifactName} artifact`;
  const centerBody = inspectingAgentOutput
    ? getStepDisplayContent(selectedStep)
    : activeArtifact?.body || getStepDisplayContent(selectedStep);
  const contextEntries = readContextEntries(run?.context);
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
    ? `${formatWorkerDisplayName(selectedStepContext.agent_snapshot?.name ?? selectedStepContext.agent_id)} artifacts`
    : selectedArtifact
      ? `${inferGoalArtifactName(run, selectedArtifact)} artifact`
      : `${finalArtifactName} artifact`;
  const artifactPanelDescription = selectedStepContext
    ? "Artifacts produced by the selected agent and its attempts."
    : selectedArtifact
      ? `Versions of ${selectedArtifact.artifact_key}.`
      : "This is the job result. Agent outputs are intermediate; the artifact is the reviewed deliverable.";
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
      title: workerSlotLabel(step.step_index, step.agent_snapshot?.name ?? step.agent_id),
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
  const gateAgentOutput = useMemo(() => {
    if (!pendingGate) return "";
    return readGateAgentOutput(pendingGate.payload_json, getStepDisplayContent(gateStep));
  }, [gateStep, pendingGate]);
  useEffect(() => {
    if (!pendingGate || gateUiMode !== "memory_confirmation") return;
    setMemorySelections((current) => {
      if (current[pendingGate.id]) return current;
      return {
        ...current,
        [pendingGate.id]: memoryGateItems.filter((item) => item.include !== false).map((item) => item.id),
      };
    });
  }, [gateUiMode, memoryGateItems, pendingGate]);

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
      setSelectedStepId(null);
      setSelectedArtifactId(null);
      setLeftTab("output");
      setGateTransitionStepId(currentStep?.id ?? gate.id);
      void post(`/api/workflows/runs/${runId}/gates/${gate.id}/input`, { value: inputValues[gate.id] ?? "" });
      return;
    }
    setSelectedStepId(null);
    setSelectedArtifactId(null);
    setLeftTab("output");
    setGateTransitionStepId(currentStep?.id ?? gate.id);
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
      <div className="grid min-h-screen place-items-center bg-[#f7f8fb]" style={{ fontFamily: "var(--font-fustat)" }}>
        <div className="flex items-center gap-3 border border-[#d1d5db] bg-white px-5 py-4">
          <Loader2 className="size-5 animate-spin text-[#6b7280]" />
          <span className="text-[14px] font-medium text-[#6b7280]">Loading run…</span>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f8fb] p-8" style={{ fontFamily: "var(--font-fustat)" }}>
        <p className="border border-[#d9a3a3] bg-[#fdf2f2] px-5 py-4 text-[14px] text-[#991b1b]">
          {error ?? "Job not found"}
        </p>
      </main>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
    <main className="min-h-screen bg-[#f7f8fb] text-[#121a31]" style={{ fontFamily: "var(--font-fustat)" }}>
      <div className="mx-auto max-w-[1660px] px-7 py-6">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[#9ca3af]">
              <Link href="/dashboard/loops" className="hover:text-[#111827]">Loops</Link>
              <ChevronRight className="size-3.5" />
              <Link href={`/dashboard/loops/${workflowId}`} className="hover:text-[#111827]">{run.workflow_title}</Link>
              <ChevronRight className="size-3.5" />
              <span className="text-[#111827]">Job #{run.id.slice(0, 6)}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1
                className="text-[25px] font-bold leading-tight tracking-[-0.02em] text-[#111827]"
                style={{ fontFamily: "var(--font-title)" }}
              >
                {run.workflow_title}
              </h1>
              <RunStatusPill status={run.status} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <EditorialToolbarButton title="Info"><Info className="size-4" /></EditorialToolbarButton>
            <EditorialToolbarButton title="Job details" onClick={() => setDetailsOpen(true)}>
              <Code className="size-4" />
            </EditorialToolbarButton>
            <EditorialToolbarButton title="Refresh" onClick={() => void load()}>
              <RefreshCw className="size-4" />
            </EditorialToolbarButton>
            <EditorialToolbarButton title="Panels"><Columns2 className="size-4" /></EditorialToolbarButton>
            {!terminalStatuses.has(run.status) ? (
              <EditorialToolbarButton
                title="Cancel"
                danger
                disabled={Boolean(busy)}
                onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)}
              >
                <X className="size-4" />
              </EditorialToolbarButton>
            ) : null}
            <EditorialToolbarButton title="More"><MoreHorizontal className="size-4" /></EditorialToolbarButton>
          </div>
        </header>

        <RunStatusBand
          gateResolvedFlash={gateResolvedFlash}
          transitioningAfterGate={transitioningAfterGate}
          pendingGate={pendingGate}
          gateUiMode={gateUiMode}
          runStatus={run.status}
          failureStep={failureRetryTarget}
          failureMessage={failureMessage}
          isGateRejected={isGateRejected}
          activeStageName={activeStageName}
          busy={Boolean(busy)}
          approveLabel={
            gateUiMode === "missing_input"
              ? "Submit input"
              : gateUiMode === "memory_confirmation" && selectedMemoryIds.size > 0
                ? `Approve (${selectedMemoryIds.size})`
                : "Approve"
          }
          approveDisabled={
            gateUiMode === "missing_input" && pendingGate
              ? !(inputValues[pendingGate.id] ?? "").trim()
              : false
          }
          onApprove={() => {
            if (!pendingGate || !gateUiMode) return;
            submitGate(
              pendingGate,
              gateUiMode === "missing_input" ? "input" : "approve",
            );
          }}
          onReject={() => pendingGate && submitGate(pendingGate, "reject")}
          onRerun={() => {
            if (!failureRetryTarget) return;
            void post(`/api/workflows/runs/${runId}/steps/${failureRetryTarget.id}/retry`);
          }}
        />

        <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1fr)_490px]">
          <section className="flex h-full min-h-0 flex-col space-y-5">

            <AnimatePresence mode="wait">
              {showMissingInputWorkspace && pendingGate ? (
                <motion.div
                  key="missing-input"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <EditorialWorkspaceShell className="flex min-h-[640px] flex-col">
                    <div className="shrink-0 border-b border-[#e5e7eb] px-7 py-5">
                      <h2 className="text-[20px] font-bold tracking-[-0.02em] text-[#111827]">
                        {gateWorkspaceTitle("missing_input")}
                      </h2>
                      <p className="mt-1.5 text-[14px] leading-6 text-[#6b7280]">
                        {gateWorkspaceSubtitle(pendingGate, "missing_input")}
                      </p>
                    </div>
                    <MissingInputWorkspace
                      agentOutput={gateAgentOutput}
                      agentName={formatWorkerDisplayName(gateStep?.agent_snapshot?.name ?? gateStep?.agent_id ?? "the agent")}
                      fieldLabel={resolveInputFieldLabel(run.definition?.inputsRequired, pendingGate.question)}
                      fieldPlaceholder={resolveInputFieldPlaceholder(run.definition?.inputsRequired)}
                      value={inputValues[pendingGate.id] ?? ""}
                      onChange={(value) => setInputValues((current) => ({ ...current, [pendingGate.id]: value }))}
                      onSubmit={() => submitGate(pendingGate, "input")}
                      submitDisabled={!(inputValues[pendingGate.id] ?? "").trim()}
                      busy={Boolean(busy)}
                    />
                  </EditorialWorkspaceShell>
                </motion.div>
              ) : showGateWorkspace && pendingGate && gateUiMode ? (
                <motion.div
                  key="gate-review"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <EditorialWorkspaceShell className="flex min-h-[640px] flex-col">
                    <div className="shrink-0 border-b border-[#e5e7eb] px-7 py-6">
                      <h2 className="text-[20px] font-bold tracking-[-0.02em] text-[#111827]">
                        {gateWorkspaceTitle(gateUiMode)}
                      </h2>
                      <p className="mt-1.5 text-[14px] leading-6 text-[#6b7280]">
                        {gateWorkspaceSubtitle(pendingGate, gateUiMode)}
                        {nextWorkerName ? (
                          <>
                            {" "}
                            <span className="font-medium text-[#374151]">Then → {nextWorkerName}</span>
                          </>
                        ) : null}
                      </p>
                    </div>

                    <div id="gate-draft-editor" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      {gateUiMode === "memory_confirmation" ? (
                        <MemoryEditCanvas
                          gateId={pendingGate.id}
                          items={memoryGateItems}
                          selectedIds={selectedMemoryIds}
                          onToggle={toggleMemorySelection}
                          onInspect={setMemoryDetail}
                        />
                      ) : null}
                      {(gateUiMode === "draft_review" || gateUiMode === "pre_send") ? (
                        <DraftReviewWorkspace agentOutput={gateAgentOutput || centerBody}>
                          {activeCanvasArtifact && activeCanvasTemplate ? (
                            <ArtifactRenderer
                              artifact={activeCanvasArtifact}
                              runId={runId}
                              saving={busy?.includes("/canvas/email") ?? false}
                              onSave={async (data) => {
                                await saveCanvasEmail(activeCanvasArtifact, data as Parameters<typeof saveCanvasEmail>[1]);
                              }}
                            />
                          ) : undefined}
                        </DraftReviewWorkspace>
                      ) : null}
                    </div>

                    {gateUiMode === "memory_confirmation" ? (
                      <div className="mt-auto border-t border-[#d1d5db] bg-[#fafafa] px-7 py-3">
                        <p className="text-[13px] text-[#6b7280]">
                          {memoryGateItems.length} proposed · {selectedMemoryIds.size} selected
                        </p>
                      </div>
                    ) : null}
                  </EditorialWorkspaceShell>
                </motion.div>
              ) : transitioningAfterGate ? (
                <motion.div
                  key="gate-transition"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="h-full"
                >
                  <EditorialWorkspaceShell className="h-full min-h-0 overflow-hidden">
                    <LeftPanelLoader />
                  </EditorialWorkspaceShell>
                </motion.div>
              ) : (
                <motion.div
                  key="report-artifact"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="h-full"
                >
                  <EditorialWorkspaceShell className="h-full min-h-0 overflow-hidden">
              <Tabs value={leftTab} onValueChange={(value) => setLeftTab(value as typeof leftTab)} className="flex h-full min-h-0 flex-1 flex-col gap-0">
                <CardHeader className="border-b border-[#e5e7eb] bg-white px-7 py-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <CardTitle className="truncate text-[20px] font-bold tracking-[-0.02em] text-[#111827]">{centerTitle}</CardTitle>
                    </div>
                  </div>
                  <TabsList variant="line" className="mt-5 h-auto gap-1 rounded-none bg-transparent p-0">
                    <TabsTrigger value="output" className="h-10 rounded-none border-b-2 border-transparent px-4 text-sm font-semibold capitalize text-[#6b7280] data-[state=active]:border-[#111827] data-[state=active]:bg-transparent data-[state=active]:text-[#111827] data-[state=active]:shadow-none">
                      Output
                    </TabsTrigger>
                    <TabsTrigger value="attempts" className="h-10 rounded-none border-b-2 border-transparent px-4 text-sm font-semibold capitalize text-[#6b7280] data-[state=active]:border-[#111827] data-[state=active]:bg-transparent data-[state=active]:text-[#111827] data-[state=active]:shadow-none">
                      Attempts
                    </TabsTrigger>
                    <TabsTrigger value="artifact" className="h-10 rounded-none border-b-2 border-transparent px-4 text-sm font-semibold capitalize text-[#6b7280] data-[state=active]:border-[#111827] data-[state=active]:bg-transparent data-[state=active]:text-[#111827] data-[state=active]:shadow-none">
                      Artifact
                    </TabsTrigger>
                  </TabsList>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto p-7">
                    <TabsContent value="output" className="mt-0 h-full">
                      <div className="flex min-h-full flex-col border border-[#e5e7eb] bg-white p-7">
                        {inspectingAgentOutput ? (
                          centerBody ? (
                            <div className="prose prose-slate max-w-none text-[16px] leading-7">
                              <Streamdown>{centerBody}</Streamdown>
                            </div>
                          ) : (
                            <div className="grid min-h-[360px] place-items-center border border-dashed border-[#d1d5db] bg-[#fafafa] p-8 text-center text-sm text-[#6b7280]">
                              No output from this agent yet.
                            </div>
                          )
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
                          <div className="grid min-h-[560px] place-items-center border border-dashed border-[#d1d5db] bg-[#fafafa] p-8 text-center text-sm text-[#6b7280]">
                            No {finalArtifactName.toLowerCase()} artifact yet. The stable runtime will update this projection when the job produces its reviewed result.
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="attempts" className="mt-0 h-full">
                      <div className="flex min-h-full flex-col space-y-0 divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                        {(attemptsForSelectedStep.length > 0 ? attemptsForSelectedStep : orderedSteps).map((attempt) => (
                          <div key={attempt.id} className="bg-white p-5">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Agent {attempt.step_index + 1} · Attempt {attempt.attempt}</p>
                                <h3 className="mt-1 text-lg font-extrabold">{formatWorkerDisplayName(attempt.agent_snapshot?.name ?? attempt.agent_id)}</h3>
                              </div>
                              <div className="flex items-center gap-2">
                                {(attempt.status === "failed" || attempt.status === "cancelled") ? (
                                  <EditorialActionButton
                                    label="Rerun"
                                    glyph="rerun"
                                    variant="secondary"
                                    disabled={Boolean(busy)}
                                    onClick={() => void post(`/api/workflows/runs/${runId}/steps/${attempt.id}/retry`)}
                                    className="h-8 px-3 text-[12px]"
                                  />
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
                          <div className="grid min-h-[360px] place-items-center border border-dashed border-[#d1d5db] bg-[#fafafa] p-8 text-sm text-[#6b7280]">
                            No agent attempts yet.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="artifact" className="mt-0 h-full">
                      <div className="flex min-h-full flex-col border border-[#e5e7eb]">
                        <div className="border-b border-[#e5e7eb] bg-[#fafafa] p-5">
                          <h3 className="text-lg font-bold text-[#111827]">{artifactPanelTitle}</h3>
                          <p className="mt-1 text-sm leading-6 text-[#6b7280]">
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
                            className="flex w-full items-center gap-4 border-b border-[#e5e7eb] bg-white p-5 text-left transition-colors last:border-b-0 hover:bg-[#fafafa]"
                          >
                            <div className="grid size-12 place-items-center bg-[#f3f4f6] text-[#4b5563]">
                              <FileText className="size-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-bold text-[#111827]">{inferGoalArtifactName(run, artifact)} artifact</p>
                              <p className="mt-1 text-sm text-[#6b7280]">Version {artifact.version} · {artifact.kind}</p>
                            </div>
                          </button>
                        ))}
                        {artifactPanelArtifacts.length === 0 ? (
                          <div className="grid min-h-[360px] place-items-center p-8 text-sm text-[#6b7280]">
                            No artifacts found for this selection.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>
                  </CardContent>
              </Tabs>
                  </EditorialWorkspaceShell>
                  </motion.div>
              )}
            </AnimatePresence>
          </section>

          <aside className="space-y-5 overflow-hidden" style={{ fontFamily: "var(--font-fustat)" }}>
            <EditorialSidebarPanel title="Final result" icon={Puzzle}>
              {finalArtifacts.map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => {
                    setSelectedArtifactId(artifact.id);
                    setSelectedStepId(null);
                    setLeftTab("output");
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-[#e5e7eb] px-5 py-4 text-left transition-colors last:border-b-0 hover:bg-[#fafafa]",
                    (selectedArtifactId === artifact.id || (!selectedArtifactId && latestArtifact?.id === artifact.id))
                      && "bg-[#f8fbff] ring-1 ring-inset ring-[#2563eb]/20",
                  )}
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-md border border-[#d1d5db] bg-[#f9fafb] text-[#4b5563]">
                    <FileText className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p
                      className="truncate text-[15px] font-semibold text-[#111827]"
                      style={{ fontFamily: "var(--font-title)" }}
                    >
                      {inferGoalArtifactName(run, artifact)} artifact
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-[#9ca3af]">v{artifact.version} · {artifact.kind}</p>
                  </div>
                </button>
              ))}
              {finalArtifacts.length === 0 ? (
                <p className="border border-dashed border-[#d1d5db] bg-[#fafafa] px-5 py-6 text-[13px] text-[#9ca3af]">
                  {pendingGate
                    ? "Blocked until approval completes."
                    : transitioningAfterGate
                      ? "Approval received. Waiting for the next artifact."
                      : `No ${finalArtifactName.toLowerCase()} artifact yet.`}
                </p>
              ) : null}
            </EditorialSidebarPanel>

            <EditorialSidebarPanel
              title="Agents"
              icon={Bot}
              meta={(
                <div className="flex flex-col items-end gap-2">
                  <EditorialMetaTag tone={run.status === "succeeded" ? "neutral" : "blue"}>{agentPanelStatusLabel}</EditorialMetaTag>
                  <AgentProgressPips steps={latestSteps} currentStepId={currentStep?.id} />
                </div>
              )}
            >
              <ParentAgentRow
                parentName={parentAgentNarrative.parentName}
                roster={parentAgentNarrative.roster}
                statusLine={parentAgentNarrative.statusLine}
                parentRunPhase={parentRunPhase}
                onHire={() => showHiringToast(parentAgentNarrative.parentName)}
                onSelect={() => {
                  setSelectedArtifactId(null);
                  setSelectedStepId(selectedStep?.id ?? latestSteps[0]?.id ?? null);
                  setLeftTab("output");
                }}
                onInfo={() => setAgentInfoStepId("parent")}
              />

              <ChildAgentsShell>
                <ChildAgentsHeader count={latestSteps.length} />
                {latestSteps.map((step) => {
                  const selected = selectedStepId === step.id || (!selectedStepId && selectedStep?.id === step.id);
                  const phase = resolveStepRowPhase(step, currentStep, pendingGate);
                  const isCurrent = currentStep?.id === step.id;
                  return (
                    <ChildAgentRow
                      key={step.id}
                      step={step}
                      phase={phase}
                      selected={selected}
                      isCurrent={isCurrent}
                      toolRefs={resolveStepToolRefs(step, run?.definition)}
                      onSelect={() => {
                        setSelectedStepId(step.id);
                        setSelectedArtifactId(null);
                        setLeftTab("output");
                      }}
                      onHire={() => showHiringToast(formatWorkerDisplayName(step.agent_snapshot?.name ?? step.agent_id))}
                      onInfo={() => setAgentInfoStepId(step.id)}
                      onRerun={() => void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`)}
                    />
                  );
                })}
              </ChildAgentsShell>
              {latestSteps.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-[#9ca3af]">Waiting for an agent claim.</p>
              ) : null}
            </EditorialSidebarPanel>

            <EditorialSidebarPanel title="From memory" icon={Brain}>
              {contextEntries.map((entry) => (
                <div key={`${entry.key}:${entry.value}`} className="border-b border-[#e5e7eb] px-5 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <p
                      className="truncate text-[14px] font-semibold text-[#111827]"
                      style={{ fontFamily: "var(--font-title)" }}
                    >
                      {entry.key}
                    </p>
                    <EditorialMetaTag tone="amber">context</EditorialMetaTag>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-[#6b7280]">
                    {stripDisplayEmoji(entry.value)}
                  </p>
                </div>
              ))}
              {contextEntries.length === 0 ? (
                <p className="border border-dashed border-[#d1d5db] bg-[#fafafa] px-5 py-6 text-[13px] text-[#9ca3af]">
                  {pendingGate ? "Pending your selection above." : "No approved memory or submitted input yet."}
                </p>
              ) : null}
            </EditorialSidebarPanel>
          </aside>
        </div>

        <Dialog open={agentInfoStepId !== null} onOpenChange={(open) => { if (!open) setAgentInfoStepId(null); }}>
          <DialogContent showCloseButton={false} className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[520px] flex-col overflow-hidden p-0 sm:!max-w-[520px]">
            <DialogClose asChild>
              <button
                type="button"
                className="absolute right-3 top-3 z-10 grid size-7 place-items-center text-[#9ca3af] transition-colors hover:text-[#6b7280]"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </DialogClose>
            <VisuallyHidden asChild>
              <DialogTitle>
                {agentInfoStepId === "parent" ? parentAgentNarrative.parentName : (
                  (() => {
                    const s = orderedSteps.find((st) => st.id === agentInfoStepId);
                    return s?.agent_snapshot?.name ?? s?.agent_id ?? "Agent info";
                  })()
                )}
              </DialogTitle>
            </VisuallyHidden>
            {agentInfoStepId === "parent" ? (
              <>
                <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-6 py-5">
                  <h2 className="text-[18px] font-bold tracking-[-0.02em] text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
                    {parentAgentNarrative.parentName}
                  </h2>
                  <p className="mt-1 text-[13px] text-[#9ca3af]">{parentAgentNarrative.roster}</p>
                </div>
                <div className="min-h-0 overflow-y-auto px-6 py-5 space-y-4 text-[14px] leading-6 text-[#374151]">
                  <p>{parentAgentNarrative.parentTask}</p>
                  {parentAgentNarrative.goalLine ? (
                    <p className="font-medium text-[#1f2937]">{parentAgentNarrative.goalLine}</p>
                  ) : null}
                  <p>{parentAgentNarrative.orchestration}</p>
                  <p className="font-medium text-[#4a6f96]">{parentAgentNarrative.statusLine}</p>
                </div>
              </>
            ) : agentInfoStepId ? (
              (() => {
                const step = orderedSteps.find((s) => s.id === agentInfoStepId);
                if (!step) return null;
                const toolRefs = resolveStepToolRefs(step, run?.definition);
                return (
                  <>
                    <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-6 py-5">
                      <div className="flex items-center gap-3">
                        <AgentIconBox {...resolveChildAgentIcon(step)} />
                        <div>
                          <p className="font-mono text-[9px] font-semibold tracking-[0.12em] text-[#9ca3af] uppercase">
                            Agent · slot {step.step_index + 1}
                          </p>
                          <h2 className="text-[18px] font-bold tracking-[-0.02em] text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
                            {formatWorkerDisplayName(step.agent_snapshot?.name ?? step.agent_id)}
                          </h2>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <AttemptChip attempt={step.attempt} />
                            {toolRefs.map((toolRef) => (
                              <LegendaryToolBadge key={`${step.id}-info-${toolRef}`} toolRef={toolRef} />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="min-h-0 overflow-y-auto px-6 py-5 text-[14px] leading-6 text-[#374151]">
                      <p>{step.agent_snapshot?.task ?? "No task description available."}</p>
                      {getStepText(step) ? (
                        <div className="mt-4 rounded border border-[#e5e7eb] bg-[#fafafa] p-4">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af] mb-2">Latest output</p>
                          <p className="text-[13px] leading-6 text-[#6b7280] whitespace-pre-wrap">
                            {stripDisplayEmoji(preview(getStepText(step) || ""))}
                          </p>
                        </div>
                      ) : null}
                      {step.error_json?.message ? (
                        <div className="mt-4 rounded border border-red-200 bg-red-50 p-4">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600 mb-2">Error</p>
                          <p className="text-[13px] leading-6 text-red-700">{step.error_json.message}</p>
                        </div>
                      ) : null}
                    </div>
                  </>
                );
              })()
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(memoryDetail)} onOpenChange={(open) => {
          if (!open) setMemoryDetail(null);
        }}>
          <DialogContent showCloseButton={false} className={cn(editorialDialogContentClass, "max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] sm:!max-w-[860px]")}>
            <DialogClose asChild>
              <button
                type="button"
                className="absolute right-3 top-3 z-10 grid size-7 place-items-center text-[#9ca3af] transition-colors hover:text-[#6b7280]"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </DialogClose>
            <VisuallyHidden asChild>
              <DialogTitle>Memory details</DialogTitle>
            </VisuallyHidden>
            <EditorialDialogHeader
              title="Memory details"
              description="Review the memory before deciding whether it should be included."
            />
            {memoryDetail ? (
              <EditorialDialogBody className="space-y-4">
                <EditorialField label="Memory ID">
                  <p className="break-all font-mono text-[13px] font-semibold">{memoryDetail.id}</p>
                </EditorialField>
                <EditorialField label="Memory content">
                  <div className="whitespace-pre-wrap text-[14px] leading-7 text-[#374151]">
                    {stripDisplayEmoji(memoryDetail.excerpt)}
                  </div>
                </EditorialField>
                <div className="grid gap-3 sm:grid-cols-3">
                  <EditorialField label="Score">
                    <p className="text-[18px] font-bold">
                      {typeof memoryDetail.score === "number" ? memoryDetail.score.toFixed(4) : "n/a"}
                    </p>
                  </EditorialField>
                  <EditorialField label="Confidence">
                    <p className="text-[18px] font-bold">
                      {typeof memoryDetail.confidence === "number" ? memoryDetail.confidence.toFixed(3) : "n/a"}
                    </p>
                  </EditorialField>
                  <EditorialField label="Role">
                    <p className="font-semibold">{memoryDetail.evidenceRole ? label(memoryDetail.evidenceRole) : "n/a"}</p>
                  </EditorialField>
                </div>
                {memoryDetail.reason ? (
                  <EditorialField label="Why it matched">{memoryDetail.reason}</EditorialField>
                ) : null}
                {memoryDetail.metadata ? (
                  <EditorialField label="Metadata">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border border-[#111827] bg-[#111827] p-4 font-mono text-[11px] leading-5 text-[#f3f4f6]">
                      {formatJsonFull(memoryDetail.metadata)}
                    </pre>
                  </EditorialField>
                ) : null}
              </EditorialDialogBody>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogContent showCloseButton={false} className={cn(editorialDialogContentClass, "h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] bg-[#f7f8fb] sm:!max-w-[1400px]")}>
            <DialogClose asChild>
              <button
                type="button"
                className="absolute right-3 top-3 z-10 grid size-7 place-items-center text-[#9ca3af] transition-colors hover:text-[#6b7280]"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </DialogClose>
            <VisuallyHidden asChild>
              <DialogTitle>Job details</DialogTitle>
            </VisuallyHidden>
            <EditorialDialogHeader
              title="Job details"
              description="Logs, agent outputs, token usage, and estimated cost for this job."
              meta={(
                <>
                  <EditorialMetaTag tone="blue">{label(run.status)}</EditorialMetaTag>
                  <EditorialMetaTag>{latestSteps.length} agents</EditorialMetaTag>
                  <EditorialMetaTag>{runLogEvents.length} events</EditorialMetaTag>
                  <EditorialMetaTag>{numberFormatter.format(usageSummary.calls)} AI calls</EditorialMetaTag>
                </>
              )}
            />

            <EditorialDialogBody className="bg-[#f7f8fb]">
              <div className="space-y-5">
                <EditorialStatGrid>
                  <EditorialStat label="Prompt tokens" value={numberFormatter.format(usageSummary.promptTokens)} />
                  <EditorialStat label="Completion tokens" value={numberFormatter.format(usageSummary.completionTokens)} />
                  <EditorialStat label="Total tokens" value={numberFormatter.format(usageSummary.totalTokens)} />
                  <EditorialStat label="Estimated cost" value={currencyFormatter.format(usageSummary.estimatedCostUsd)} />
                </EditorialStatGrid>

                <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
                  <section className="space-y-4">
                    <EditorialPanel title="Logs">
                      <div className="space-y-4">
                        <EditorialField label="Timeline">
                          <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                            {logEntries.length > 0 ? logEntries.map((entry) => (
                              <EditorialListRow
                                key={entry.id}
                                title={entry.title}
                                subtitle={formatDateTime(entry.time)}
                                meta={<StatusBadge status={entry.status} />}
                                body={entry.body ? <pre className="whitespace-pre-wrap break-words font-sans">{entry.body}</pre> : null}
                              />
                            )) : (
                              <EditorialEmpty>No run events yet.</EditorialEmpty>
                            )}
                          </div>
                        </EditorialField>

                        <EditorialField label="Agent outputs">
                          <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                            {orderedSteps.length > 0 ? orderedSteps.map((step) => (
                              <EditorialListRow
                                key={step.id}
                                title={`Agent ${step.step_index + 1} · Attempt ${step.attempt}`}
                                subtitle={`${formatWorkerDisplayName(step.agent_snapshot?.name ?? step.agent_id)} · ${formatDateTime(step.finished_at ?? step.started_at ?? step.created_at)}`}
                                meta={<StatusBadge status={step.status} />}
                                body={preview(getStepText(step) || step.error_json?.message || formatJsonPreview(step.output_json?.data), 480)}
                              />
                            )) : (
                              <EditorialEmpty>No step outputs yet.</EditorialEmpty>
                            )}
                          </div>
                        </EditorialField>
                      </div>
                    </EditorialPanel>

                    {memorySearchTraces.length > 0 ? (
                      <EditorialPanel title="Memory search trace">
                        <div className="space-y-4">
                          {memorySearchTraces.map((entry, index) => (
                            <div key={`${entry.step.id}:${index}`} className="border border-[#e5e7eb] bg-[#fafafa]">
                              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#e5e7eb] px-4 py-3">
                                <div>
                                  <p className="text-[14px] font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
                                    {formatWorkerDisplayName(entry.step.agent_snapshot?.name ?? entry.step.agent_id)}
                                  </p>
                                  <p className="text-[12px] text-[#9ca3af]">
                                    Agent {entry.step.step_index + 1} · Attempt {entry.step.attempt}
                                  </p>
                                </div>
                                <EditorialMetaTag>{entry.validation?.confidence ?? "unknown"} confidence</EditorialMetaTag>
                              </div>

                              <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-[#e5e7eb]">
                                <EditorialField label="Search log" className="border-0 border-b border-[#e5e7eb] lg:border-b-0">
                                  <div className="space-y-1 text-[13px] text-[#374151]">
                                    <p>Query: {entry.query ?? "unknown"}</p>
                                    <p>Accepted: {entry.validation?.acceptedCount ?? 0} memories</p>
                                    <p>Rejected: {entry.validation?.rejectedCount ?? 0} candidates</p>
                                    {entry.validation?.noEvidenceReason ? (
                                      <p className="text-[#6b7280]">{entry.validation.noEvidenceReason}</p>
                                    ) : null}
                                  </div>
                                </EditorialField>

                                <EditorialField label="Retrieval trace" className="border-0">
                                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#6b7280]">
                                    {formatJsonFull({
                                      queryPlan: entry.queryPlan,
                                      retrieval: entry.retrieval,
                                      validation: entry.validation,
                                    })}
                                  </pre>
                                </EditorialField>
                              </div>

                              <EditorialField label="Memories found" className="border-0 border-t border-[#e5e7eb]">
                                <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                                  {entry.sources.length > 0 ? entry.sources.map((source) => (
                                    <div key={source.id} className="bg-white px-3 py-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="font-mono text-[12px] font-semibold text-[#111827]">{source.id}</p>
                                        <div className="flex flex-wrap gap-2">
                                          {typeof source.confidence === "number" ? (
                                            <EditorialMetaTag>confidence {Math.round(source.confidence * 100)}%</EditorialMetaTag>
                                          ) : null}
                                          {source.evidenceRole ? <EditorialMetaTag>{source.evidenceRole}</EditorialMetaTag> : null}
                                        </div>
                                      </div>
                                      <p className="mt-2 max-h-[18rem] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-[#6b7280]">{source.text}</p>
                                      {source.reason ? <p className="mt-2 text-[12px] text-[#9ca3af]">{source.reason}</p> : null}
                                    </div>
                                  )) : (
                                    <EditorialEmpty>No validated memories were returned.</EditorialEmpty>
                                  )}
                                </div>
                              </EditorialField>

                              <EditorialField label="All candidates" className="border-0 border-t border-[#e5e7eb]">
                                <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                                  {entry.candidates.length > 0 ? entry.candidates.map((candidate) => (
                                    <div key={candidate.id} className="bg-white px-3 py-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="font-mono text-[12px] font-semibold text-[#111827]">{candidate.id}</p>
                                        <div className="flex flex-wrap gap-2">
                                          <EditorialMetaTag>score {candidate.score.toFixed(3)}</EditorialMetaTag>
                                          <EditorialMetaTag tone={candidate.accepted ? "blue" : "neutral"}>
                                            {candidate.accepted ? "accepted" : "rejected"}
                                          </EditorialMetaTag>
                                        </div>
                                      </div>
                                      <p className="mt-2 max-h-[16rem] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-[#6b7280]">{candidate.text}</p>
                                    </div>
                                  )) : (
                                    <EditorialEmpty>No candidates were collected for this search.</EditorialEmpty>
                                  )}
                                </div>
                              </EditorialField>
                            </div>
                          ))}
                        </div>
                      </EditorialPanel>
                    ) : null}
                  </section>

                  <aside className="space-y-4">
                    <EditorialPanel title="Usage">
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          <EditorialStat label="Est. prompt tokens" value={numberFormatter.format(usageSummary.estimatedPromptTokens)} />
                          <EditorialStat label="Est. completion tokens" value={numberFormatter.format(usageSummary.estimatedCompletionTokens)} />
                          <EditorialStat label="Est. total tokens" value={numberFormatter.format(usageSummary.estimatedTotalTokens)} />
                          <EditorialStat label="AI calls" value={numberFormatter.format(usageSummary.calls)} />
                        </div>

                        <EditorialField label="Models">
                          <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                            {usageModels.length > 0 ? usageModels.map(([model, count]) => (
                              <div key={model} className="flex items-center justify-between gap-3 bg-white px-3 py-2">
                                <span className="truncate text-[13px] font-semibold text-[#374151]">{model}</span>
                                <EditorialMetaTag>{numberFormatter.format(count)}</EditorialMetaTag>
                              </div>
                            )) : (
                              <EditorialEmpty>No model usage recorded.</EditorialEmpty>
                            )}
                          </div>
                        </EditorialField>

                        <EditorialField label="Usage by agent">
                          <div className="divide-y divide-[#e5e7eb] border border-[#e5e7eb]">
                            {stepUsageRows.filter((row) => row.usage.calls > 0 || row.usage.promptTokens > 0 || row.usage.completionTokens > 0).length > 0 ? stepUsageRows
                              .filter((row) => row.usage.calls > 0 || row.usage.promptTokens > 0 || row.usage.completionTokens > 0)
                              .map((row) => (
                                <div key={row.step.id} className="bg-white px-3 py-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="truncate text-[13px] font-semibold text-[#111827]">
                                      {formatWorkerDisplayName(row.step.agent_snapshot?.name ?? row.step.agent_id)}
                                    </p>
                                    <EditorialMetaTag>attempt {row.step.attempt}</EditorialMetaTag>
                                  </div>
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-[#6b7280]">
                                    <span>Prompt: {numberFormatter.format(row.usage.promptTokens)}</span>
                                    <span>Completion: {numberFormatter.format(row.usage.completionTokens)}</span>
                                    <span>Total: {numberFormatter.format(row.usage.totalTokens)}</span>
                                    <span>Cost: {currencyFormatter.format(row.usage.estimatedCostUsd)}</span>
                                  </div>
                                </div>
                              )) : (
                              <EditorialEmpty>No LLM usage recorded.</EditorialEmpty>
                            )}
                          </div>
                        </EditorialField>
                      </div>
                    </EditorialPanel>
                  </aside>
                </div>
              </div>
            </EditorialDialogBody>
          </DialogContent>
        </Dialog>

      </div>
    </main>
    </TooltipProvider>
  );
}

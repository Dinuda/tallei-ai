"use client";

import Image from "next/image";
import { ChevronLeft, FileText, Loader2, Megaphone, RefreshCw, Search, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  CHANNEL_LABELS,
  engineGateHeadline,
  getTaskOutput,
  isApprovalTask,
  isBroadcastDeliveryTask,
  isEmailBuildTask,
  isWriterTask,
  stripMarkdown,
  type TaskLike,
} from "./run-view-utils";

export type AgentRowTask = TaskLike & {
  id: string;
  startedAt: string | null;
  completedAt: string | null;
  inputJson: unknown;
  outputJson: unknown;
  latestComment: { body: string } | null;
};

const AGENT_THEME = {
  research: {
    icon: Search,
    chip: "bg-sky-100 text-sky-700",
    active: "bg-sky-50 ring-1 ring-sky-200/80",
  },
  writer: {
    icon: FileText,
    chip: "bg-indigo-100 text-indigo-700",
    active: "bg-indigo-50 ring-1 ring-indigo-200/80",
  },
  publicist: {
    icon: ShieldCheck,
    chip: "bg-amber-100 text-amber-700",
    active: "bg-amber-50 ring-1 ring-amber-200/80",
  },
  broadcast: {
    icon: Megaphone,
    chip: "bg-orange-100 text-orange-700",
    active: "bg-orange-50 ring-1 ring-orange-200/80",
  },
  default: {
    icon: FileText,
    chip: "bg-slate-100 text-slate-700",
    active: "ring-1 ring-slate-200/80",
  },
} as const;

function agentTheme(task: AgentRowTask) {
  const key = `${task.agentId} ${task.toolKey} ${(task.assignedTools ?? []).map((tool) => tool.ref).join(" ")}`.toLowerCase();
  if (key.includes("memory_search") || key.includes("web_search") || key.includes("research")) return AGENT_THEME.research;
  if (isWriterTask(task)) return AGENT_THEME.writer;
  if (isBroadcastDeliveryTask(task)) return AGENT_THEME.broadcast;
  if (key.includes("email_builder_compose") || key.includes("email_builder_render")) return AGENT_THEME.publicist;
  if (isApprovalTask(task)) return AGENT_THEME.publicist;
  if (key.includes("gmail") || key.includes("public") || key.includes("publish") || key.includes("send")) return AGENT_THEME.publicist;
  return AGENT_THEME.default;
}

function toolBadges(task: AgentRowTask): string[] {
  if (task.assignedTools?.length) {
    return task.assignedTools.map((tool) => tool.ref.split(".").slice(-1)[0]?.replace(/_/g, " ") ?? tool.ref);
  }
  if (task.toolKey) return [task.toolKey.replace(/_/g, " ")];
  return [];
}

function brief(task: AgentRowTask): string {
  const full = stripMarkdown(getTaskOutput(task));
  return full.length > 72 ? `${full.slice(0, 72)}…` : full;
}

function duration(task: AgentRowTask): string {
  if (!task.startedAt) return "";
  const start = new Date(task.startedAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function responsibilityBrief(task: AgentRowTask): string | null {
  if (isBroadcastDeliveryTask(task)) {
    return "After approval and recipient upload, sync contacts and submit the broadcast.";
  }
  if (isApprovalTask(task)) {
    return "Review the draft, ask approval questions, and send the approval request only.";
  }
  if (isEmailBuildTask(task)) {
    return "Compose and render the visual email from the writer draft only.";
  }
  if (isWriterTask(task)) {
    return "Produce the draft content for this run.";
  }
  return null;
}

function statusPill(status: string) {
  if (status === "done" || status === "completed") return "bg-sky-100 text-sky-700";
  if (status === "in_progress") return "bg-blue-100 text-blue-700";
  if (status === "blocked" || status === "failed") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

function taskStatusPill(task: AgentRowTask, awaitingGateInput: boolean): string {
  if (awaitingGateInput) return "bg-amber-100 text-amber-700";
  if (task.status === "blocked" && isApprovalTask(task)) return "bg-amber-100 text-amber-700";
  return statusPill(task.status);
}

function statusLabel(task: AgentRowTask, awaitingGateInput: boolean, runPausedForGate: boolean) {
  if (awaitingGateInput) return "Awaiting your input";
  const status = task.status;
  if (status === "done" || status === "completed") return "Done";
  if (status === "in_progress" && runPausedForGate) return "Paused";
  if (status === "in_progress") return "Working";
  if (status === "blocked" && isApprovalTask(task)) return "Awaiting approval";
  if (status === "blocked") return "Blocked";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

export function AgentRow({
  task,
  open,
  onToggle,
  onRerun,
  rerunning = false,
  canRerun = false,
  metadataSummary = null,
  engineGateStageId = null,
  runPausedForGate = false,
}: {
  task: AgentRowTask;
  open: boolean;
  onToggle: () => void;
  onRerun?: () => void;
  rerunning?: boolean;
  canRerun?: boolean;
  metadataSummary?: string | null;
  engineGateStageId?: string | null;
  runPausedForGate?: boolean;
}) {
  const gateStage = Boolean(engineGateStageId && task.agentId === engineGateStageId);
  const working = task.status === "in_progress" && !runPausedForGate;
  const theme = agentTheme(task);
  const Icon = theme.icon;
  const awaitingGateInput = Boolean(gateStage && (task.status === "blocked" || runPausedForGate));

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full rounded-xl bg-white p-3 text-left shadow-sm transition-all",
          open && "ring-2 ring-slate-400",
          !open && gateStage && runPausedForGate && "ring-2 ring-amber-300 bg-amber-50/40",
          !open && working && theme.active,
        )}
      >
        <div className="flex items-start gap-2">
          <span className={cn("mt-1 grid size-8 shrink-0 place-items-center rounded-lg", theme.chip)}>
            <Icon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="block truncate text-sm font-semibold text-slate-900">{task.agentName}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {canRerun && onRerun ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onRerun(); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onRerun(); } }}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {rerunning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    Rerun
                  </span>
                ) : null}
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", taskStatusPill(task, awaitingGateInput))}>
                  {task.status === "done" || task.status === "completed" ? duration(task) : statusLabel(task, awaitingGateInput, runPausedForGate)}
                </span>
              </div>
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-slate-500">
              {metadataSummary ?? responsibilityBrief(task) ?? brief(task)}
            </p>
            {metadataSummary && responsibilityBrief(task) ? (
              <p className="mt-1 line-clamp-1 text-[10px] leading-4 text-slate-400">{responsibilityBrief(task)}</p>
            ) : null}
            {toolBadges(task).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {toolBadges(task).map((label) => (
                  <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <ChevronLeft className={cn("mt-1 size-4 shrink-0 transition-transform", open ? "text-slate-900" : "text-slate-400")} />
        </div>
      </button>
    </div>
  );
}

export function AgentPlaceholder() {
  return (
    <div className="space-y-2">
      {[0.9, 0.75, 0.85].map((w, i) => (
        <div key={i} className="animate-pulse rounded-xl bg-white p-3 shadow-sm">
          <div className="flex gap-3">
            <div className="size-8 rounded-lg bg-slate-200" />
            <div className="flex-1 space-y-2">
              <div className="h-3 rounded-full bg-slate-200" style={{ width: `${w * 100}%` }} />
              <div className="h-2 rounded-full bg-slate-100" style={{ width: "55%" }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CeoRow({
  name,
  statusLabel: label,
  runStatus,
}: {
  name: string;
  statusLabel: string;
  runStatus: string;
}) {
  const awaitingApproval = runStatus.includes("waiting") || label.includes("approval") || label.includes("review") || label.includes("input");
  const pill =
    runStatus === "completed"
      ? "bg-sky-100 text-sky-700"
      : runStatus === "running" || runStatus === "strategy_approved"
        ? "bg-blue-100 text-blue-700"
        : awaitingApproval
          ? "bg-amber-100 text-amber-800"
          : runStatus === "blocked" || runStatus === "failed"
            ? "bg-rose-100 text-rose-700"
            : "bg-slate-100 text-slate-700";

  return (
    <div className="flex items-start gap-3 rounded-xl bg-gradient-to-br from-orange-50/60 to-white p-3 shadow-sm ring-1 ring-orange-200/50">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-900 shadow-sm">
        <Image src="/icon.png" alt="Tallei" width={16} height={16} className="size-8" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-900">{name}</span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", pill)}>
            {label}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">Orchestrates the run</p>
      </div>
    </div>
  );
}

export type ApprovalGateInfo = {
  id: string;
  title: string;
  artifactId: string | null;
  channels: string[];
  status: string;
  gateType?: string | null;
};

export function ApprovalGateRow({ gate }: { gate: ApprovalGateInfo }) {
  const isPending = gate.status === "pending";
  const isEngineGate = Boolean(gate.gateType);
  const label = isEngineGate ? engineGateHeadline(gate.gateType ?? null) : "Approval gate";

  return (
    <div className={cn(
      "rounded-xl border p-3 shadow-sm",
      isPending ? "border-amber-200 bg-amber-50/80 ring-1 ring-amber-200/60" : "border-slate-200 bg-white",
    )}>
      <div className="flex items-start gap-2">
        <span className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          isPending ? "bg-amber-100" : "bg-slate-100",
        )}>
          <ShieldCheck className={cn("size-4", isPending ? "text-amber-700" : "text-slate-500")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900">{label}</span>
            <span className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
              isPending ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-700",
            )}>
              {isPending ? (isEngineGate ? "Action required" : "Awaiting approval") : gate.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{gate.title}</p>
          {!isEngineGate && gate.channels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {gate.channels.map((channel) => (
                <span key={channel} className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-600 ring-1 ring-slate-200">
                  {CHANNEL_LABELS[channel] ?? channel}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

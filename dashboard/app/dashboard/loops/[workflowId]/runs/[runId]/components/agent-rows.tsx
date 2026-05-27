"use client";

import Image from "next/image";
import { ChevronLeft, FileText, Megaphone, Search } from "lucide-react";

import { cn } from "@/lib/utils";

export type AgentRowTask = {
  id: string;
  agentName: string;
  toolKey: string;
  agentId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  inputJson: unknown;
  outputJson: unknown;
  latestComment: { body: string } | null;
  assignedTools?: Array<{ ref: string }>;
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
  const refs = (task.assignedTools ?? []).map((tool) => tool.ref).join(" ");
  const key = `${task.agentId} ${task.toolKey} ${refs}`.toLowerCase();
  if (key.includes("memory_search") || key.includes("research")) return AGENT_THEME.research;
  if (key.includes("llm_only") || key.includes("write") || key.includes("draft")) return AGENT_THEME.writer;
  if (key.includes("gmail") || key.includes("public") || key.includes("publish")) return AGENT_THEME.publicist;
  return AGENT_THEME.default;
}

function toolBadges(task: AgentRowTask): string[] {
  if (task.assignedTools?.length) {
    return task.assignedTools.map((tool) => tool.ref.split(".").slice(-1)[0]?.replace(/_/g, " ") ?? tool.ref);
  }
  if (task.toolKey) return [task.toolKey.replace(/_/g, " ")];
  return [];
}

function readRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stripMarkdown(v: string) {
  return v
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOutput(task: AgentRowTask): string {
  const out = readRecord(task.outputJson);
  const candidates = [out.text, out.message, out.summary, out.draft, task.latestComment?.body];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const inp = readRecord(task.inputJson);
  const agent = readRecord(inp.agent);
  if (typeof agent.task === "string") return agent.task.trim();
  return task.toolKey.replace(/_/g, " ");
}

function brief(task: AgentRowTask): string {
  const full = stripMarkdown(getOutput(task));
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

function statusPill(status: string) {
  if (status === "done" || status === "completed") return "bg-sky-100 text-sky-700";
  if (status === "in_progress") return "bg-blue-100 text-blue-700";
  if (status === "blocked" || status === "failed") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

function statusLabel(status: string) {
  if (status === "done" || status === "completed") return "Done";
  if (status === "in_progress") return "Working";
  if (status === "blocked") return "Blocked";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

export function AgentRow({
  task,
  open,
  onToggle,
}: {
  task: AgentRowTask;
  open: boolean;
  onToggle: () => void;
}) {
  const active = task.status === "in_progress";
  const theme = agentTheme(task);
  const Icon = theme.icon;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl bg-white p-3 text-left shadow-sm transition-all",
          "hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40",
          active && theme.active,
          open && "ring-2 ring-slate-300"
        )}
      >
        <ChevronLeft className="mt-1 size-4 shrink-0 text-slate-500" />
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", theme.chip)}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900">{task.agentName}</span>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", statusPill(task.status))}>
              {task.status === "done" || task.status === "completed" ? duration(task) : statusLabel(task.status)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-4 text-slate-500">{brief(task)}</p>
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
  const pill =
    runStatus === "completed"
      ? "bg-sky-100 text-sky-700"
      : runStatus === "running" || runStatus === "strategy_approved"
        ? "bg-blue-100 text-blue-700"
        : runStatus.includes("waiting")
          ? "bg-amber-100 text-amber-800"
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

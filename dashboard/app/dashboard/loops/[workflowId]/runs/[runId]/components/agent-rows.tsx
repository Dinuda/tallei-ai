"use client";

import { useState } from "react";
import { ChevronDown, FileText, Megaphone, Search } from "lucide-react";
import { Streamdown } from "streamdown";

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
};

function taskIcon(task: AgentRowTask) {
  const key = `${task.agentId} ${task.toolKey}`.toLowerCase();
  if (key.includes("research")) return <Search className="size-3.5" />;
  if (key.includes("write") || key.includes("draft")) return <FileText className="size-3.5" />;
  return <Megaphone className="size-3.5" />;
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
  const candidates = [out.message, out.summary, out.draft, task.latestComment?.body];
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
  return full.length > 90 ? full.slice(0, 90) + "…" : full;
}

function duration(task: AgentRowTask): string {
  if (!task.startedAt) return "";
  const start = new Date(task.startedAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function statusDot(status: string) {
  if (status === "done" || status === "completed")
    return "bg-emerald-500";
  if (status === "in_progress")
    return "bg-blue-500 animate-pulse";
  if (status === "blocked" || status === "failed")
    return "bg-destructive";
  return "bg-muted-foreground/30";
}

function statusLabel(status: string) {
  if (status === "done" || status === "completed") return "Done";
  if (status === "in_progress") return "Working";
  if (status === "blocked") return "Blocked";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

export function AgentRow({ task }: { task: AgentRowTask }) {
  const [open, setOpen] = useState(false);
  const active = task.status === "in_progress";
  const done = task.status === "done" || task.status === "completed";

  return (
    <div className="group/row">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-blue-50/60 hover:bg-blue-50/80"
        )}
      >
        <span
          className={cn(
            "mt-[5px] size-1.5 shrink-0 rounded-full transition-colors",
            statusDot(task.status)
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <span className={cn("text-sm font-medium leading-none", !done && !active && "text-muted-foreground")}>
              {task.agentName}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {done ? duration(task) : statusLabel(task.status)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground line-clamp-1">
            {brief(task)}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "mt-0.5 size-3 shrink-0 text-muted-foreground/50 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="ml-5 mb-1 px-2.5">
          <div className="rounded-md bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            <Streamdown>{getOutput(task)}</Streamdown>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentPlaceholder() {
  return (
    <div className="space-y-2.5 px-2.5 py-3">
      {[0.8, 0.6, 0.7].map((w, i) => (
        <div key={i} className="flex items-start gap-2.5 animate-pulse">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 rounded bg-muted" style={{ width: `${w * 100}%` }} />
            <div className="h-2 rounded bg-muted/60" style={{ width: "60%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

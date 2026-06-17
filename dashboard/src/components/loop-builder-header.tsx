"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  Pencil,
  Radio,
} from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { loopRunHref, triggerSourceLabel, type LoopRunSummary } from "@/lib/loop-run-navigation";

type BuilderSession = {
  phase?: string;
  goal?: string;
  workflowId?: string | null;
  currentProposal?: { title?: string } | null;
  buildContract?: {
    requirements?: Array<{
      kind?: string;
      value?: unknown;
    }>;
  } | null;
};

type WorkflowMeta = {
  status?: string;
  latestRun?: { id: string } | null;
  verificationStatus?: string | null;
};

type LoopStatusKey = "draft" | "verifying" | "ready" | "live" | "failed" | "paused" | "archived";

function resolveLoopStatus(
  session: BuilderSession | null,
  workflow: WorkflowMeta | null,
): {
  key: LoopStatusKey;
  label: string;
} {
  if (!session?.workflowId) {
    if (session?.phase === "failed") return { key: "failed", label: "Save failed" };
    return { key: "draft", label: "Not saved" };
  }
  const status = workflow?.status;
  if (status === "active") return { key: "live", label: "Live" };
  if (session.phase === "failed") return { key: "failed", label: "Failed" };
  if (status === "verifying") {
    const verificationStatus = workflow?.verificationStatus;
    if (verificationStatus === "failed") return { key: "failed", label: "Verification failed" };
    if (verificationStatus === "awaiting_confirmation") return { key: "ready", label: "Ready to activate" };
    if (verificationStatus === "running" || verificationStatus === "pending") {
      return { key: "verifying", label: "Verifying" };
    }
    return { key: "verifying", label: "Verifying" };
  }
  if (status === "paused") return { key: "paused", label: "Paused" };
  if (status === "archived") return { key: "archived", label: "Archived" };
  return { key: "draft", label: "Saved" };
}

const HEADER_CHIP = "inline-flex h-7 shrink-0 items-center gap-1 rounded-none border px-2 text-[11px] font-medium transition-colors";

const STATUS_STYLES: Record<LoopStatusKey, string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-600",
  verifying: "border-amber-200 bg-amber-50 text-amber-800",
  ready: "border-[#cce89e] bg-[#f8fdf2] text-[#3d5c18]",
  live: "border-[#cce89e] bg-[#f8fdf2] text-[#3d5c18]",
  failed: "border-red-200 bg-red-50 text-red-700",
  paused: "border-slate-200 bg-slate-50 text-slate-600",
  archived: "border-slate-200 bg-slate-50 text-slate-500",
};

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function prettyRunStatus(status: string): string {
  return status.replace(/_/g, " ");
}

type LoopRun = LoopRunSummary & {
  createdAt: string;
  updatedAt?: string;
};

async function loadWorkflowMeta(workflowId: string): Promise<WorkflowMeta | null> {
  const [workflowResponse, verificationResponse] = await Promise.all([
    fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
    fetch(`/api/workflows/loops/${workflowId}/verification`, { cache: "no-store" }),
  ]);
  const workflowPayload = await workflowResponse.json().catch(() => ({}));
  if (!workflowResponse.ok) return null;
  const loop = (workflowPayload as { loop?: WorkflowMeta }).loop ?? null;
  if (!loop) return null;
  const verificationPayload = await verificationResponse.json().catch(() => ({}));
  const verificationStatus = (verificationPayload as { verification?: { status?: string } }).verification?.status ?? null;
  return { ...loop, verificationStatus };
}

function LoopBuilderHeaderStatus({
  workflowId,
  session,
  workflow,
}: {
  workflowId: string;
  session: BuilderSession;
  workflow: WorkflowMeta | null;
}) {
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(payload.runs)) {
        setRuns(payload.runs as LoopRun[]);
      }
    } finally {
      setRunsLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const status = workflow?.status;
    if (status !== "active" && status !== "verifying") return;
    const interval = window.setInterval(() => { void loadRuns(); }, 30_000);
    const onFocus = () => { void loadRuns(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadRuns, workflow?.status]);

  const loopStatus = resolveLoopStatus(session, workflow);
  const approvalRuns = useMemo(
    () => runs.filter((run) => run.status === "waiting_for_approval"),
    [runs],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <span className={cn(HEADER_CHIP, STATUS_STYLES[loopStatus.key])}>
        {loopStatus.key === "live" ? <Radio size={10} className="text-[#7eb71b]" /> : null}
        {loopStatus.key === "ready" ? <CheckCircle2 size={10} className="text-[#7eb71b]" /> : null}
        {loopStatus.key === "verifying" ? <Loader2 size={10} className="animate-spin" /> : null}
        {loopStatus.key === "failed" ? <AlertCircle size={10} /> : null}
        {loopStatus.label}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Popover open={runsOpen} onOpenChange={setRunsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(HEADER_CHIP, "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}
              onClick={() => { if (!runsOpen) void loadRuns(); }}
            >
              Show runs
              <ChevronDown size={12} className={cn("transition-transform", runsOpen && "rotate-180")} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 rounded-none border border-slate-200 p-0">
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="text-xs font-semibold text-slate-900">Recent runs</p>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {runsLoading && runs.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-slate-500">
                  <Loader2 size={12} className="animate-spin" />
                  Loading runs…
                </div>
              ) : runs.length === 0 ? (
                <p className="px-3 py-4 text-xs text-slate-500">No runs yet.</p>
              ) : runs.map((run) => (
                <Link
                  key={run.id}
                  href={loopRunHref(workflowId, run.id)}
                  className="flex items-start justify-between gap-2 border-b border-slate-50 px-3 py-2.5 text-left transition hover:bg-slate-50 last:border-0"
                  onClick={() => setRunsOpen(false)}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-900">Run {run.id.slice(0, 8)}</p>
                    <p className="mt-0.5 truncate text-[10px] text-slate-500">
                      {triggerSourceLabel(run.triggerSource, run.triggerLabel)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-400">{formatRunDate(run.createdAt)}</p>
                  </div>
                  <span className="shrink-0 rounded-none border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] capitalize text-slate-600">
                    {prettyRunStatus(run.status ?? "unknown")}
                  </span>
                </Link>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {approvalRuns.length > 0 ? (
          <Popover open={approvalsOpen} onOpenChange={setApprovalsOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(HEADER_CHIP, "border-[#7eb71b] bg-[#7eb71b] text-white hover:bg-[#6aa015]")}
              >
                <CheckCircle2 size={12} />
                Approvals ({approvalRuns.length})
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 rounded-none border border-slate-200 p-0">
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="text-xs font-semibold text-slate-900">Agent approvals</p>
                <p className="mt-0.5 text-[10px] text-slate-500">Runs waiting for your review</p>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {approvalRuns.map((run) => (
                  <Link
                    key={run.id}
                    href={loopRunHref(workflowId, run.id)}
                    className="flex items-start justify-between gap-2 border-b border-slate-50 px-3 py-2.5 text-left transition hover:bg-[#f8fdf2] last:border-0"
                    onClick={() => setApprovalsOpen(false)}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-900">Run {run.id.slice(0, 8)}</p>
                      <p className="mt-0.5 truncate text-[10px] text-slate-500">
                        {triggerSourceLabel(run.triggerSource, run.triggerLabel)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-slate-400">{formatRunDate(run.updatedAt ?? run.createdAt)}</p>
                    </div>
                    <Clock size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  </Link>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  );
}

export function LoopBuilderHeader() {
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get("session");
  const [title, setTitle] = useState("Create a loop");
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [session, setSession] = useState<BuilderSession | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowMeta | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadSession = useCallback(async (id: string) => {
    const response = await fetch(`/api/loop-builder/sessions/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load session");
    const data = await response.json();
    const nextSession = data?.session ?? null;
    setSession(nextSession);
    const t = nextSession?.currentProposal?.title || nextSession?.goal || "Draft loop";
    setTitle(t);

    const workflowId = nextSession?.workflowId as string | null | undefined;
    if (workflowId) {
      setWorkflow(await loadWorkflowMeta(workflowId));
    } else {
      setWorkflow(null);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setTitle("Create a loop");
      setSession(null);
      setWorkflow(null);
      return;
    }
    void loadSession(sessionId).catch((err) => {
      console.error(err);
      setTitle("Draft loop");
    });
  }, [sessionId, loadSession]);

  useEffect(() => {
    if (!sessionId) return;
    const onSessionUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      void loadSession(sessionId).catch(console.error);
    };
    window.addEventListener("loop-builder-session-updated", onSessionUpdated);
    return () => window.removeEventListener("loop-builder-session-updated", onSessionUpdated);
  }, [sessionId, loadSession]);

  useEffect(() => {
    if (!sessionId || !session?.workflowId) return;
    const status = workflow?.status;
    if (status !== "active" && status !== "verifying") return;
    const interval = window.setInterval(() => {
      void loadSession(sessionId).catch(console.error);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [sessionId, session?.workflowId, workflow?.status, loadSession]);

  const handleEditStart = () => {
    if (!sessionId) return;
    setDraftTitle(title);
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const handleSave = async () => {
    if (!sessionId) return;
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === title) {
      setIsEditing(false);
      return;
    }
    setTitle(trimmed);
    setIsEditing(false);
    try {
      const res = await fetch(`/api/loop-builder/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error("Failed to save title");
    } catch (err) {
      console.error(err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSave();
    else if (e.key === "Escape") setIsEditing(false);
  };

  return (
    <div className="ml-4 hidden min-w-0 flex-1 items-center gap-4 border-l border-slate-200 pl-6 md:flex">
      <div className="min-w-0 shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Loop Builder</div>
        {isEditing ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="-ml-1 w-[280px] rounded border border-slate-300 px-1 text-sm font-semibold leading-none text-slate-900 outline-none focus:ring-2 focus:ring-slate-400"
          />
        ) : (
          <div
            className="group flex cursor-pointer items-center gap-2 transition-opacity hover:opacity-80"
            onClick={handleEditStart}
          >
            <div className="line-clamp-1 max-w-[280px] text-sm font-semibold leading-none text-slate-900" title={title}>
              {title}
            </div>
            {sessionId ? <Pencil size={12} className="text-slate-400" /> : null}
          </div>
        )}
      </div>

      {sessionId && session?.workflowId ? (
        <LoopBuilderHeaderStatus
          workflowId={session.workflowId}
          session={session}
          workflow={workflow}
        />
      ) : sessionId && session ? (
        <div className="flex items-center gap-2">
          <span className={cn(HEADER_CHIP, STATUS_STYLES.draft)}>
            {resolveLoopStatus(session, workflow).label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function notifyLoopBuilderSessionUpdated(sessionId: string): void {
  window.dispatchEvent(new CustomEvent("loop-builder-session-updated", { detail: { sessionId } }));
}

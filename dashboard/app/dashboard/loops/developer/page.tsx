"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Code2, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { triggerSourceLabel } from "@/lib/loop-run-navigation";

type WorkflowListItem = {
  id: string;
  title: string;
  latestRun: {
    id: string;
    status: string;
    triggerSource?: "manual" | "schedule" | "event";
    triggerLabel?: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
};

type LiveRun = {
  workflowId: string;
  workflowTitle: string;
  runId: string;
  status: string;
  triggerSource?: "manual" | "schedule" | "event";
  triggerLabel?: string | null;
  createdAt: string;
  updatedAt: string;
};

function isLiveRunStatus(status?: string): boolean {
  if (!status) return false;
  return ["queued", "running", "waiting_for_approval", "waiting_for_interaction"].includes(status);
}

function prettyRunStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function DeveloperLoopsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to load workflows");
      setWorkflows(Array.isArray(payload.workflows) ? (payload.workflows as WorkflowListItem[]) : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workflows");
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const activeRuns = useMemo<LiveRun[]>(() => {
    const items: LiveRun[] = [];
    for (const workflow of workflows) {
      const run = workflow.latestRun;
      if (!run || !isLiveRunStatus(run.status)) continue;
      items.push({
        workflowId: workflow.id,
        workflowTitle: workflow.title,
        runId: run.id,
        status: run.status,
        triggerSource: run.triggerSource,
        triggerLabel: run.triggerLabel,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [workflows]);

  return (
    <div className="flex h-[calc(100vh-72px)] flex-col">
      <header className="flex mx-auto max-w-5xl w-full flex-wrap items-end justify-between gap-4 border-b py-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">Live loops</h1>
          <p className="mt-0.5 text-sm text-[var(--text-2)]">
            Triggered and in-progress runs — open to review, approve, or intervene.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
            {activeRuns.length} live
          </div>
          <Button type="button" variant="outline" className="h-9 gap-1.5" onClick={loadWorkflows} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </Button>
          <Button asChild className="gap-1.5 h-9 bg-orange-500 text-white hover:bg-orange-600 rounded-none">
            <Link href="/dashboard/loops">
              <Code2 size={14} />
              Loops
              <ArrowRight size={12} />
            </Link>
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--muted)] px-6 py-6">
        {error ? (
          <div className="mx-auto mb-4 max-w-5xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        <div className="mx-auto max-w-5xl">
          {activeRuns.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-5 rounded-2xl border border-[var(--border-light)] bg-white text-center">
              <div className="grid h-16 w-16 place-items-center rounded-xl bg-slate-100 shadow-sm">
                <Sparkles size={28} className="text-slate-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-[var(--text)]">No live runs right now</h2>
                <p className="mt-1 max-w-sm text-sm text-[var(--text-2)]">
                  Scheduled and event-triggered runs will show up here when they need review or approval.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {activeRuns.map((run) => (
                <button
                  key={`${run.workflowId}:${run.runId}`}
                  type="button"
                  onClick={() => router.push(`/dashboard/loops/${run.workflowId}/runs/${run.runId}`)}
                  className="border border-[var(--border-light)] bg-white p-4 text-left transition hover:border-[var(--text)] hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text)]">{run.workflowTitle}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">Run {run.runId.slice(0, 8)}</p>
                      <p className="mt-1 text-[10px] font-medium text-[var(--text-2)]">
                        {triggerSourceLabel(run.triggerSource, run.triggerLabel)}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium capitalize text-slate-700">
                      {prettyRunStatus(run.status)}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--text-2)]">
                    <div className="rounded bg-slate-50 px-2 py-1.5">
                      Started {formatDate(run.createdAt)}
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1.5">
                      Updated {formatDate(run.updatedAt)}
                    </div>
                  </div>
                  <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--text)]">
                    Open run
                    <ArrowRight size={12} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

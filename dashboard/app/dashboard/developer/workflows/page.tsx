"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pause, Play, RefreshCw, Workflow, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

type Tab = "running" | "scheduled" | "history";

type RunningWorkflow = {
  temporalWorkflowId: string;
  workflowId: string;
  runId: string;
  workflowTitle: string;
  status: string;
  startTime: string | null;
};

type HistoryWorkflow = RunningWorkflow & {
  closeTime: string | null;
};

type ScheduleItem = {
  scheduleId: string;
  workflowId: string;
  workflowTitle: string;
  cron: string[];
  timezone: string | null;
  paused: boolean;
  nextRunAt: string | null;
};

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function DeveloperWorkflowsPage() {
  const [tab, setTab] = useState<Tab>("running");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningWorkflow[]>([]);
  const [history, setHistory] = useState<HistoryWorkflow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runningRes, historyRes, schedulesRes] = await Promise.all([
        fetch("/api/developer/temporal/workflows/running", { cache: "no-store" }),
        fetch("/api/developer/temporal/workflows/history?limit=50", { cache: "no-store" }),
        fetch("/api/developer/temporal/schedules", { cache: "no-store" }),
      ]);

      const runningPayload = await runningRes.json().catch(() => ({}));
      const historyPayload = await historyRes.json().catch(() => ({}));
      const schedulesPayload = await schedulesRes.json().catch(() => ({}));

      if (!runningRes.ok) throw new Error(runningPayload.error ?? "Failed to load running workflows");
      if (!historyRes.ok) throw new Error(historyPayload.error ?? "Failed to load workflow history");
      if (!schedulesRes.ok) throw new Error(schedulesPayload.error ?? "Failed to load schedules");

      setRunning(Array.isArray(runningPayload.workflows) ? runningPayload.workflows : []);
      setHistory(Array.isArray(historyPayload.workflows) ? historyPayload.workflows : []);
      setSchedules(Array.isArray(schedulesPayload.schedules) ? schedulesPayload.schedules : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Temporal data");
      setRunning([]);
      setHistory([]);
      setSchedules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string) {
    setBusyId(path);
    setError(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Action failed");
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-[calc(100vh-72px)] flex-col">
      <header className="mx-auto flex w-full max-w-5xl flex-wrap items-end justify-between gap-4 border-b py-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">Workflows</h1>
          <p className="mt-0.5 text-sm text-[var(--text-2)]">
            Temporal loop executions, schedules, and recent history.
          </p>
        </div>
        <Button type="button" variant="outline" className="h-9 gap-1.5" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--muted)] px-6 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex flex-wrap gap-2">
            {([
              ["running", `Running (${running.length})`],
              ["scheduled", `Scheduled (${schedules.length})`],
              ["history", `History (${history.length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={
                  tab === id
                    ? "rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white"
                    : "rounded-full border border-[var(--border-light)] bg-white px-4 py-1.5 text-xs font-medium text-[var(--text-2)]"
                }
              >
                {label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mb-4 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : null}

          {loading ? (
            <div className="flex min-h-[240px] items-center justify-center text-sm text-[var(--text-muted)]">
              <Loader2 size={18} className="mr-2 animate-spin" />
              Loading Temporal visibility...
            </div>
          ) : null}

          {!loading && tab === "running" ? (
            running.length === 0 ? (
              <EmptyState title="No running workflows" description="Active loop runs started via Temporal will appear here." />
            ) : (
              <div className="grid gap-3">
                {running.map((item) => (
                  <article key={item.temporalWorkflowId} className="rounded-2xl border border-[var(--border-light)] bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text)]">{item.workflowTitle}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">Run {item.runId.slice(0, 8)} · {item.status}</p>
                        <p className="mt-1 text-xs text-[var(--text-2)]">Started {formatWhen(item.startTime)}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/dashboard/loops/${item.workflowId}/runs/${item.runId}`}>Open run</Link>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyId === item.temporalWorkflowId}
                          onClick={() => void post(`/api/developer/temporal/workflows/${encodeURIComponent(item.temporalWorkflowId)}/cancel`)}
                        >
                          <XCircle size={14} />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : null}

          {!loading && tab === "scheduled" ? (
            schedules.length === 0 ? (
              <EmptyState title="No schedules" description="Activated loops with cron schedules register a Temporal Schedule here." />
            ) : (
              <div className="grid gap-3">
                {schedules.map((schedule) => (
                  <article key={schedule.scheduleId} className="rounded-2xl border border-[var(--border-light)] bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text)]">{schedule.workflowTitle}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">{schedule.cron.join(", ") || "No cron"} · {schedule.timezone ?? "UTC"}</p>
                        <p className="mt-1 text-xs text-[var(--text-2)]">
                          {schedule.paused ? "Paused" : `Next run ${formatWhen(schedule.nextRunAt)}`}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/dashboard/loops/${schedule.workflowId}`}>Open loop</Link>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyId === schedule.scheduleId}
                          onClick={() => void post(
                            `/api/developer/temporal/schedules/${encodeURIComponent(schedule.scheduleId)}/${schedule.paused ? "unpause" : "pause"}`,
                          )}
                        >
                          {schedule.paused ? <Play size={14} /> : <Pause size={14} />}
                          {schedule.paused ? "Resume" : "Pause"}
                        </Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : null}

          {!loading && tab === "history" ? (
            history.length === 0 ? (
              <EmptyState title="No recent history" description="Completed Temporal loop workflows from the last week appear here." />
            ) : (
              <div className="grid gap-3">
                {history.map((item) => (
                  <article key={`${item.temporalWorkflowId}:${item.closeTime ?? "open"}`} className="rounded-2xl border border-[var(--border-light)] bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text)]">{item.workflowTitle}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">Run {item.runId.slice(0, 8)} · {item.status}</p>
                        <p className="mt-1 text-xs text-[var(--text-2)]">
                          {formatWhen(item.startTime)} → {formatWhen(item.closeTime)}
                        </p>
                      </div>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/dashboard/loops/${item.workflowId}/runs/${item.runId}`}>Open run</Link>
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : null}
        </div>
      </main>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--border-light)] bg-white text-center">
      <div className="grid h-14 w-14 place-items-center rounded-xl bg-slate-100">
        <Workflow size={24} className="text-slate-400" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
        <p className="mt-1 max-w-sm text-sm text-[var(--text-2)]">{description}</p>
      </div>
    </div>
  );
}

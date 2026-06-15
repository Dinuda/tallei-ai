"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Info, Loader2, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";

import { loopBuilderHref, resolveLoopRunNavigation, triggerSourceLabel } from "@/lib/loop-run-navigation";

type LoopRun = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  triggerSource?: "manual" | "schedule" | "event";
  triggerLabel?: string | null;
};

type LoopAgent = {
  id: string;
  name: string;
  task: string;
  tools?: Array<{ ref: string }>;
};

type LoopWorkflow = {
  id: string;
  title: string;
  status: string;
  goal?: string;
  scheduleRrule: string;
  nextRunAt: string | null;
  createdAt: string;
  builderSessionId?: string | null;
  latestRun?: { id: string } | null;
  definitionVersion?: string;
  runnableSpec?: {
    goal: string;
    schedule?: { cron?: string; timezone?: string };
    noSlopSpec?: {
      specJson?: {
        agents?: Array<{ name: string; goal: string }>;
      };
    };
  };
  definition?: {
    goal: string;
    schedule?: { cron?: string; timezone?: string };
    agentGraph?: {
      parent?: { name: string; task: string };
      children?: LoopAgent[];
    };
  };
};

type TriggerActivity = {
  mode: "event" | "schedule" | "none";
  registration: {
    toolkit: string;
    triggerSlug: string;
    triggerInstanceId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  schedule: {
    cron: string;
    timezone: string;
    nextRunAt: string | null;
    lastScheduledAt: string | null;
  } | null;
  recentEvents: Array<{
    id: string;
    externalEventId: string;
    runId: string | null;
    receivedAt: string;
  }>;
};

function loopGoal(workflow: LoopWorkflow): string {
  return workflow.goal
    ?? workflow.runnableSpec?.goal
    ?? workflow.definition?.goal
    ?? workflow.title;
}

function loopSchedule(workflow: LoopWorkflow): { cron: string; timezone: string } {
  return {
    cron: workflow.definition?.schedule?.cron
      ?? workflow.runnableSpec?.schedule?.cron
      ?? workflow.scheduleRrule
      ?? "",
    timezone: workflow.definition?.schedule?.timezone
      ?? workflow.runnableSpec?.schedule?.timezone
      ?? "UTC",
  };
}

function loopAgents(workflow: LoopWorkflow): LoopAgent[] {
  const graphChildren = workflow.definition?.agentGraph?.children;
  if (graphChildren?.length) return graphChildren;

  const specAgents = workflow.runnableSpec?.noSlopSpec?.specJson?.agents;
  if (!specAgents?.length) return [];

  return specAgents.map((agent, index) => ({
    id: `spec-agent-${index}`,
    name: agent.name,
    task: agent.goal,
  }));
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function prettyStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatJsonFull(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function LoopWorkflowPage() {
  const router = useRouter();
  const params = useParams<{ workflowId: string }>();
  const workflowId = params.workflowId;

  const [workflow, setWorkflow] = useState<LoopWorkflow | null>(null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [triggerActivity, setTriggerActivity] = useState<TriggerActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"run" | "open" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const loadWorkflow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [workflowRes, runsRes, triggersRes] = await Promise.all([
        fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}/triggers`, { cache: "no-store" }),
      ]);
      const workflowPayload = await workflowRes.json().catch(() => ({}));
      const runsPayload = await runsRes.json().catch(() => ({}));
      const triggersPayload = await triggersRes.json().catch(() => ({}));
      if (!workflowRes.ok) {
        throw new Error((workflowPayload as { error?: string }).error ?? "Failed to load loop");
      }
      setWorkflow((workflowPayload as { loop: LoopWorkflow }).loop);
      setRuns(Array.isArray(runsPayload.runs) ? runsPayload.runs as LoopRun[] : []);
      setTriggerActivity(triggersRes.ok ? (triggersPayload as { triggers: TriggerActivity }).triggers : null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop");
      setWorkflow(null);
      setRuns([]);
      setTriggerActivity(null);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  useEffect(() => {
    if (!workflow || workflow.status !== "active") return;
    const interval = window.setInterval(() => {
      void loadWorkflow();
    }, 30_000);
    const onFocus = () => { void loadWorkflow(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadWorkflow, workflow]);

  async function openLatestRun() {
    setBusy("open");
    setError(null);
    try {
      const href = await resolveLoopRunNavigation(workflowId, workflow?.latestRun ?? runs[0] ?? null);
      router.push(href);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to open run");
    } finally {
      setBusy(null);
    }
  }

  async function startRun() {
    setBusy("run");
    setError(null);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.run?.id) {
        throw new Error((payload as { error?: string }).error ?? "Failed to start run");
      }
      router.push(`/dashboard/loops/${workflowId}/runs/${payload.run.id}`);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to start run");
    } finally {
      setBusy(null);
    }
  }

  async function deleteLoop() {
    if (!confirm("Delete this loop? This cannot be undone.")) return;
    setBusy("delete");
    setError(null);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${workflowId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? "Failed to delete loop");
      }
      router.push("/dashboard/loops");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete loop");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading loop…
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-red-700">{error ?? "Loop not found"}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/dashboard/loops">Back to loops</Link>
        </Button>
      </div>
    );
  }

  const agents = loopAgents(workflow);
  const goal = loopGoal(workflow);
  const schedule = loopSchedule(workflow);
  const parentAgent = workflow.definition?.agentGraph?.parent;
  const isEventDriven = workflow.status === "active" && !workflow.nextRunAt;
  const triggerHint = isEventDriven
    ? "Listening for integration events. New runs will appear below automatically."
    : `Next automatic run: ${formatDate(workflow.nextRunAt)}`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 h-8 gap-1.5 px-2">
            <Link href="/dashboard/loops">
              <ArrowLeft size={14} />
              Loops
            </Link>
          </Button>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">{workflow.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--text-2)]">{goal}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workflow.builderSessionId ? (
            <Button asChild variant="outline" className="h-9 gap-1.5">
              <Link href={loopBuilderHref(workflow.builderSessionId)}>Edit in builder</Link>
            </Button>
          ) : null}
          <Button
            type="button"
            className="h-9 gap-1.5"
            onClick={() => void openLatestRun()}
            disabled={busy !== null}
          >
            {busy === "open" ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            Open loop
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setDetailsOpen(true)}
            aria-label="View loop JSON"
            title="View loop JSON"
          >
            <Info size={14} />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-800"
            onClick={() => void deleteLoop()}
            disabled={busy !== null}
          >
            {busy === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete loop
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-1.5"
            onClick={() => void startRun()}
            disabled={busy !== null}
            title="Test the loop yourself; automatic runs appear in the list below"
          >
            {busy === "run" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Start manual run
          </Button>
          <p className="w-full text-xs text-[var(--text-muted)]">
            Opens the run page — where scheduled and triggered executions appear. Use Edit in builder to change the spec.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          {parentAgent ? (
            <Card className="rounded-md p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Parent agent</div>
              <div className="mt-1 text-sm font-medium text-[var(--text)]">{parentAgent.name}</div>
              <p className="mt-1 text-sm text-[var(--text-2)]">{parentAgent.task}</p>
            </Card>
          ) : null}

          <Card className="rounded-md p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Agent roster</div>
            <div className="mt-3 space-y-3">
              {agents.length === 0 ? (
                <p className="text-sm text-[var(--text-2)]">No specialist agents configured.</p>
              ) : agents.map((agent, index) => (
                <div key={agent.id} className="rounded-md border border-[var(--border-light)] bg-[var(--muted)] p-3">
                  <div className="text-sm font-medium text-[var(--text)]">{index + 1}. {agent.name}</div>
                  <p className="mt-1 text-sm text-[var(--text-2)]">{agent.task}</p>
                  {agent.tools?.length ? (
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      Tools: {agent.tools.map((tool) => tool.ref).join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card className="rounded-md border-[var(--border-light)] bg-[#f8fdf2] p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">How runs work</div>
            <p className="mt-2 text-sm text-[var(--text-2)]">
              Active loops run on a schedule or integration events automatically. Each execution creates a run you open to review steps, approve actions, or see what was sent.
            </p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">{triggerHint}</p>
          </Card>

          <Card className="rounded-md p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Triggers</div>
            {triggerActivity?.mode === "event" ? (
              <div className="mt-2 space-y-2 text-sm text-[var(--text-2)]">
                {triggerActivity.registration ? (
                  <>
                    <p>
                      <span className="font-medium text-[var(--text)]">{triggerActivity.registration.toolkit}</span>
                      {" · "}
                      {triggerActivity.registration.triggerSlug}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      Status: {triggerActivity.registration.status} · registered {formatDate(triggerActivity.registration.createdAt)}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-amber-800">Event trigger configured in spec but not registered yet. Complete activation after verification.</p>
                )}
                <div className="mt-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Recent events</p>
                  {triggerActivity.recentEvents.length === 0 ? (
                    <p className="mt-1 text-xs text-[var(--text-muted)]">No integration events received yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {triggerActivity.recentEvents.map((event) => (
                        <li key={event.id} className="rounded border border-[var(--border-light)] bg-white px-2 py-1.5 text-xs">
                          <div className="text-[var(--text)]">{formatDate(event.receivedAt)}</div>
                          <div className="mt-0.5 truncate text-[var(--text-muted)]">{event.externalEventId}</div>
                          {event.runId ? (
                            <button
                              type="button"
                              className="mt-1 font-medium text-[var(--accent)] hover:underline"
                              onClick={() => router.push(`/dashboard/loops/${workflowId}/runs/${event.runId}`)}
                            >
                              Open run {event.runId.slice(0, 8)}
                            </button>
                          ) : (
                            <span className="mt-1 text-[var(--text-muted)]">No run linked</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : triggerActivity?.mode === "schedule" ? (
              <div className="mt-2 text-sm text-[var(--text-2)]">
                <p>Runs on schedule{triggerActivity.schedule?.cron ? `: ${triggerActivity.schedule.cron}` : ""}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Next: {formatDate(triggerActivity.schedule?.nextRunAt ?? workflow.nextRunAt)}
                  {triggerActivity.schedule?.lastScheduledAt ? ` · Last: ${formatDate(triggerActivity.schedule.lastScheduledAt)}` : ""}
                </p>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Scheduled firings appear in Runs below (source: Scheduled run).
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-[var(--text-2)]">Manual runs only — no automatic trigger configured.</p>
            )}
          </Card>

          <Card className="rounded-md p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</div>
            <p className="mt-2 text-sm text-[var(--text-2)]">
              {schedule.cron || "—"} ({schedule.timezone})
            </p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">Next run: {formatDate(workflow.nextRunAt)}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Created: {formatDate(workflow.createdAt)}</p>
          </Card>

          <Card className="rounded-md p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Runs</div>
              <span className="text-xs text-[var(--text-muted)]">{runs.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {runs.length === 0 ? (
                <p className="text-sm text-[var(--text-2)]">
                  No runs yet. This loop will run automatically when triggered. You can also start a manual test run.
                </p>
              ) : runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => router.push(`/dashboard/loops/${workflowId}/runs/${run.id}`)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-light)] bg-white px-3 py-2 text-left transition hover:border-[var(--border)] hover:bg-[var(--muted)]"
                >
                  <div>
                    <div className="text-sm font-medium text-[var(--text)]">Run {run.id.slice(0, 8)}</div>
                    <div className="text-xs text-[var(--text-muted)]">{formatDate(run.createdAt)}</div>
                    <div className="mt-1 text-[10px] font-medium text-[var(--text-2)]">
                      {triggerSourceLabel(run.triggerSource, run.triggerLabel)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium capitalize text-slate-700">
                      {prettyStatus(run.status)}
                    </span>
                    <ArrowRight size={14} className="text-[var(--text-muted)]" />
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </aside>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none bg-[#f7f8fb]">
          <DialogClose asChild>
            <button
              type="button"
              className="absolute right-3 top-3 z-10 grid size-7 place-items-center text-[#9ca3af] transition-colors hover:text-[#6b7280]"
              aria-label="Close"
            >
              <span className="text-lg leading-none">×</span>
            </button>
          </DialogClose>
          <VisuallyHidden asChild>
            <DialogTitle>Loop JSON</DialogTitle>
          </VisuallyHidden>
          <div className="flex h-full min-h-0 flex-col p-6">
            <div className="mb-4">
              <h2 className="text-xl font-bold tracking-tight text-[#111827]">Loop JSON</h2>
              <p className="mt-1 text-sm text-[#6b7280]">
                Full workflow payload, including definition and all runs.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden border border-[#e5e7eb] bg-white">
              <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[11px] leading-5 text-[#374151]">
                {formatJsonFull({ workflow, runs })}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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

type LoopRun = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
};

type LoopWorkflow = {
  id: string;
  title: string;
  status: string;
  scheduleRrule: string;
  nextRunAt: string | null;
  createdAt: string;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    agentGraph?: {
      parent?: { name: string; task: string };
      children?: Array<{ id: string; name: string; task: string; tools?: Array<{ ref: string }> }>;
    };
  };
};

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"run" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const loadWorkflow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [workflowRes, runsRes] = await Promise.all([
        fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { cache: "no-store" }),
      ]);
      const workflowPayload = await workflowRes.json().catch(() => ({}));
      const runsPayload = await runsRes.json().catch(() => ({}));
      if (!workflowRes.ok) {
        throw new Error((workflowPayload as { error?: string }).error ?? "Failed to load loop");
      }
      setWorkflow((workflowPayload as { loop: LoopWorkflow }).loop);
      setRuns(Array.isArray(runsPayload.runs) ? runsPayload.runs as LoopRun[] : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop");
      setWorkflow(null);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

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

  const agents = workflow?.definition.agentGraph?.children ?? [];

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
          <p className="mt-1 max-w-2xl text-sm text-[var(--text-2)]">{workflow.definition.goal}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          >
            {busy === "run" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Start run
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          {workflow.definition.agentGraph?.parent ? (
            <Card className="rounded-md p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Parent agent</div>
              <div className="mt-1 text-sm font-medium text-[var(--text)]">{workflow.definition.agentGraph.parent.name}</div>
              <p className="mt-1 text-sm text-[var(--text-2)]">{workflow.definition.agentGraph.parent.task}</p>
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
          <Card className="rounded-md p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</div>
            <p className="mt-2 text-sm text-[var(--text-2)]">
              {workflow.definition.schedule.cron} ({workflow.definition.schedule.timezone})
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
                <p className="text-sm text-[var(--text-2)]">No runs yet. Start one when you&apos;re ready.</p>
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

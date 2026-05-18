"use client";

import { useEffect, useState } from "react";
import { Check, Play, RefreshCw, X } from "lucide-react";

type Run = {
  id: string;
  status: string;
  runMode: string;
  createdAt: string;
  sdkRunId?: string | null;
};

type RunHealth = {
  run?: {
    id: string;
    status: string;
    connectorActionStatus: string | null;
    sdkRunId?: string | null;
  };
  sdk?: {
    status: string | null;
    eventCount: number;
    runId: string | null;
  };
  lastStep?: {
    stepName: string;
    status: string;
    createdAt: string;
  } | null;
  error?: string;
};

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [workflowId, setWorkflowId] = useState<string>("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [health, setHealth] = useState<RunHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void params.then(({ id }) => {
      if (!cancelled) setWorkflowId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    async function loadRuns() {
      setError(null);
      const res = await fetch(`/api/workflows/${workflowId}/runs`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        if (!cancelled) setError(data?.error || "Failed to load workflow runs");
        return;
      }
      const list = Array.isArray(data.runs) ? data.runs : [];
      if (!cancelled) {
        setRuns(list);
        if (list[0]?.id) setSelectedRunId(list[0].id);
      }
    }
    void loadRuns();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId || !selectedRunId) return;
    let cancelled = false;
    async function loadHealth() {
      const res = await fetch(`/api/workflows/${workflowId}/runs/${selectedRunId}/health`, { cache: "no-store" });
      const data = await res.json();
      if (!cancelled) setHealth(data);
    }
    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, [workflowId, selectedRunId]);

  async function refreshRuns() {
    if (!workflowId) return;
    const res = await fetch(`/api/workflows/${workflowId}/runs`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Failed to load workflow runs");
    const list = Array.isArray(data.runs) ? data.runs : [];
    setRuns(list);
    if (!selectedRunId && list[0]?.id) setSelectedRunId(list[0].id);
  }

  async function postRunAction(path: string, body?: unknown) {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Workflow run action failed");
      if (data?.id) setSelectedRunId(data.id);
      await refreshRuns();
      if (selectedRunId || data?.id) {
        const runId = data?.id ?? selectedRunId;
        const healthRes = await fetch(`/api/workflows/${workflowId}/runs/${runId}/health`, { cache: "no-store" });
        setHealth(await healthRes.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workflow run action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Workflow Run Inspector</h1>
          <p className="text-sm text-slate-500">{workflowId || "Loading workflow..."}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void postRunAction(`/api/workflows/${workflowId}/runs`, { run_mode: "manual" })}
            disabled={!workflowId || busy}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Play size={15} /> New run
          </button>
          <button
            type="button"
            onClick={() => void refreshRuns()}
            disabled={!workflowId || busy}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm text-rose-600">{error}</p> : null}

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-slate-500">No runs found.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selectedRunId === run.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <p className="text-sm font-medium text-slate-900">{run.id}</p>
                <p className="text-xs text-slate-500">
                  {run.status} · {run.runMode} · {new Date(run.createdAt).toLocaleString()}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">Selected Run Health</h2>
          {selectedRunId ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void postRunAction(`/api/workflows/${workflowId}/runs/${selectedRunId}/approve`)}
                disabled={busy || health?.run?.status !== "waiting_for_approval"}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-900 px-2.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                <Check size={14} /> Approve
              </button>
              <button
                type="button"
                onClick={() => void postRunAction(`/api/workflows/${workflowId}/runs/${selectedRunId}/skip`)}
                disabled={busy || !selectedRunId}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <X size={14} /> Skip
              </button>
            </div>
          ) : null}
        </div>
        {!selectedRunId ? (
          <p className="text-sm text-slate-500">Select a run to inspect.</p>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
            {JSON.stringify(health, null, 2)}
          </pre>
        )}
      </section>
    </main>
  );
}

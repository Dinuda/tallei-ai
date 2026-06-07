"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Ban, Loader2, RefreshCcw } from "lucide-react";

type StepAttempt = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: { name?: string; task?: string };
  attempt: number;
  status: string;
  output_json: { text?: string; goalEval?: { reason?: string } };
  error_json: { message?: string };
};

type Gate = {
  id: string;
  gate_type: "memory_confirmation" | "missing_input" | "draft_review" | "pre_send";
  status: string;
  question: string;
  payload_json: { items?: Array<{ id: string; excerpt: string; include?: boolean }> } & Record<string, unknown>;
  decision_json: Record<string, unknown>;
};

type Artifact = {
  id: string;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  invalidated_at: string | null;
};

type RunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  current_step_index: number | null;
  error_json: { message?: string };
  created_at: string;
  updated_at: string;
  steps: StepAttempt[];
  gates: Gate[];
  artifacts: Artifact[];
  events: Array<{ id: string; event_type: string; payload_json: Record<string, unknown>; created_at: string }>;
};

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

function statusClass(status: string) {
  if (status === "succeeded" || status === "approved" || status === "submitted") return "bg-emerald-100 text-emerald-800";
  if (status === "failed" || status === "blocked" || status === "rejected") return "bg-red-100 text-red-800";
  if (status === "waiting_for_gate" || status === "pending") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(status)}`}>{status.replaceAll("_", " ")}</span>;
}

export default function StableLoopRunPage() {
  const params = useParams<{ workflowId: string; runId: string }>();
  const workflowId = params.workflowId;
  const runId = params.runId;
  const [run, setRun] = useState<RunProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

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

  const pendingGate = useMemo(() => run?.gates.find((gate) => gate.status === "pending") ?? null, [run]);
  const visibleArtifacts = useMemo(
    () => run?.artifacts.filter((artifact) => !artifact.invalidated_at) ?? [],
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

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-slate-500" /></div>;
  }

  if (!run) {
    return <div className="p-8 text-sm text-red-700">{error ?? "Run not found"}</div>;
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={`/dashboard/loops/${workflowId}`} className="mb-3 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900">
            <ArrowLeft className="size-4" /> Back to loop
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-950">{run.workflow_title}</h1>
            <StatusBadge status={run.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-slate-500">{run.id}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <RefreshCcw className="size-4" /> Refresh
          </button>
          {!terminalStatuses.has(run.status) ? (
            <button
              onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700"
            >
              <Ban className="size-4" /> Cancel
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      {run.error_json?.message ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{run.error_json.message}</div> : null}

      {pendingGate ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">{pendingGate.gate_type.replaceAll("_", " ")}</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-950">{pendingGate.question}</h2>
            </div>
            <StatusBadge status={pendingGate.status} />
          </div>
          {pendingGate.gate_type === "missing_input" ? (
            <textarea
              value={inputValues[pendingGate.id] ?? ""}
              onChange={(event) => setInputValues((current) => ({ ...current, [pendingGate.id]: event.target.value }))}
              className="mt-4 min-h-36 w-full rounded-lg border border-amber-300 bg-white p-3 text-sm"
              placeholder="Provide the required input"
            />
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              disabled={Boolean(busy) || (pendingGate.gate_type === "missing_input" && !(inputValues[pendingGate.id] ?? "").trim())}
              onClick={() => void post(
                `/api/workflows/runs/${runId}/gates/${pendingGate.id}/${pendingGate.gate_type === "missing_input" ? "input" : "approve"}`,
                pendingGate.gate_type === "missing_input"
                  ? { value: inputValues[pendingGate.id] }
                  : {
                      channel: "dashboard",
                      ...(pendingGate.gate_type === "memory_confirmation"
                        ? { items: pendingGate.payload_json.items ?? [] }
                        : {}),
                    },
              )}
              className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pendingGate.gate_type === "missing_input" ? "Submit input" : "Approve"}
            </button>
            <button
              disabled={Boolean(busy)}
              onClick={() => void post(`/api/workflows/runs/${runId}/gates/${pendingGate.id}/reject`, { reason: "Rejected by operator" })}
              className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm text-red-700"
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border bg-white">
        <div className="border-b px-5 py-4"><h2 className="font-semibold text-slate-950">Step attempts</h2></div>
        <div className="divide-y">
          {run.steps.map((step) => (
            <article key={step.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-500">Step {step.step_index + 1}, attempt {step.attempt}</p>
                  <h3 className="mt-1 font-semibold text-slate-950">{step.agent_snapshot?.name ?? step.agent_id}</h3>
                  <p className="mt-1 text-sm text-slate-600">{step.agent_snapshot?.task}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={step.status} />
                  {(step.status === "failed" || step.status === "cancelled") ? (
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`)}
                      className="rounded-lg border px-3 py-1.5 text-xs font-medium"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
              {step.output_json?.text ? <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{step.output_json.text}</pre> : null}
              {step.error_json?.message ? <p className="mt-3 text-sm text-red-700">{step.error_json.message}</p> : null}
            </article>
          ))}
          {run.steps.length === 0 ? <p className="p-5 text-sm text-slate-500">Waiting for the runtime worker to claim the run.</p> : null}
        </div>
      </section>

      <section className="rounded-xl border bg-white">
        <div className="border-b px-5 py-4"><h2 className="font-semibold text-slate-950">Reviewed artifacts</h2></div>
        <div className="divide-y">
          {visibleArtifacts.map((artifact) => (
            <article key={artifact.id} className="p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-slate-950">{artifact.artifact_key}</h3>
                <span className="text-xs text-slate-500">v{artifact.version} · {artifact.kind}</span>
              </div>
              <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{artifact.body}</pre>
            </article>
          ))}
          {visibleArtifacts.length === 0 ? <p className="p-5 text-sm text-slate-500">No artifacts yet.</p> : null}
        </div>
      </section>
    </main>
  );
}

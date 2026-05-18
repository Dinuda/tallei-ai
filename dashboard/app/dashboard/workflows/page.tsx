"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Play, RefreshCw, X } from "lucide-react";

type Workflow = {
  id: string;
  title: string;
  status: string;
  scheduleRrule: string;
  requiresConnector: boolean;
  connectorProvider: string | null;
  updatedAt: string;
};

type Suggestion = {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  status: string;
  confidence: number;
};

export default function LoopsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(signal?: { cancelled: boolean }) {
      setLoading(true);
      setError(null);
      try {
        const [wfRes, sRes] = await Promise.all([
          fetch("/api/workflows/active", { cache: "no-store" }),
          fetch("/api/workflows", { cache: "no-store" }),
        ]);
        const wfData = await wfRes.json();
        const sData = await sRes.json();
        if (!wfRes.ok) throw new Error(wfData?.error || "Failed to load workflows");
        if (!sRes.ok) throw new Error(sData?.error || "Failed to load suggestions");
        if (!signal?.cancelled) {
          setWorkflows(Array.isArray(wfData.workflows) ? wfData.workflows : []);
          setSuggestions(Array.isArray(sData.suggestions) ? sData.suggestions : []);
        }
      } catch (e) {
        if (!signal?.cancelled) setError(e instanceof Error ? e.message : "Failed to load workflow data");
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    }

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, []);

  async function postAction(url: string, body?: unknown) {
    setBusyId(url);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Workflow action failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workflow action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Loop Center</h1>
            <p className="text-sm text-slate-500">Manage discovered suggestions, active workflows, and run health.</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {loading ? <p className="text-sm text-slate-500">Loading loop data...</p> : null}
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}

      <section className="mb-8 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Active Loops</h2>
        {workflows.length === 0 ? (
          <p className="text-sm text-slate-500">No active loops yet.</p>
        ) : (
          <div className="space-y-2">
            {workflows.map((workflow) => (
              <Link
                key={workflow.id}
                href={`/dashboard/workflows/${workflow.id}`}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{workflow.title}</p>
                  <p className="text-xs text-slate-500">
                    {workflow.status} · {workflow.scheduleRrule}
                    {workflow.requiresConnector ? ` · connector: ${workflow.connectorProvider ?? "required"}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{new Date(workflow.updatedAt).toLocaleString()}</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      void postAction(`/api/workflows/${workflow.id}/runs`, { run_mode: "manual" });
                    }}
                    disabled={busyId !== null}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs text-slate-700 hover:bg-white disabled:opacity-50"
                  >
                    <Play size={13} /> Run
                  </button>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Pending Suggestions</h2>
        {suggestions.filter((s) => s.status === "pending").length === 0 ? (
          <p className="text-sm text-slate-500">No pending suggestions.</p>
        ) : (
          <div className="space-y-2">
            {suggestions
              .filter((s) => s.status === "pending")
              .map((suggestion) => (
                <div key={suggestion.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="text-sm font-medium text-slate-900">{suggestion.title}</p>
                  <p className="text-xs text-slate-500">{suggestion.reason}</p>
                  <p className="text-xs text-slate-500">{suggestion.suggestedPrompt}</p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-slate-400">confidence {Math.round(suggestion.confidence * 100)}%</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void postAction(`/api/workflows/suggestions/${suggestion.id}/approve`, {
                          schedule_rrule: "FREQ=WEEKLY;BYDAY=FR",
                        })}
                        disabled={busyId !== null}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-slate-900 px-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Check size={13} /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void postAction(`/api/workflows/suggestions/${suggestion.id}/dismiss`, {
                          reason: "dismissed_from_portal",
                        })}
                        disabled={busyId !== null}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <X size={13} /> Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </main>
  );
}

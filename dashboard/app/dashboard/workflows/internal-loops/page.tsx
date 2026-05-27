"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type LoopAgent = {
  id: string;
  name: string;
  task: string;
  integration: string;
  toolPolicy: { allowedTools: string[]; draftBeforeExternalAction: boolean };
};

type LoopWorkflow = {
  id: string;
  title: string;
  status: string;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    schedulerTarget: "internal" | "cloudflare";
    integrations: string[];
    ceo: { name: string; task: string; policy: string };
    agents: LoopAgent[];
    draftPolicy: { requireDraftBeforeExternalAction: boolean; approvalRequiredFor: string[] };
  };
};

const DEFAULT_TASK = "User is writing a newsletter for xyz product every week. Make that a loop.";

function formatDate(value: string | null): string {
  if (!value) return "not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function InternalLoopsPage() {
  const [task, setTask] = useState(DEFAULT_TASK);
  const [cron, setCron] = useState("0 9 * * 1");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [integrations, setIntegrations] = useState("internal");
  const [loops, setLoops] = useState<LoopWorkflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => loops.find((loop) => loop.id === selectedId) ?? loops[0] ?? null,
    [loops, selectedId]
  );

  async function loadLoops() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows/internal/loops", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to load loops");
      setLoops(payload.loops ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loops");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLoops();
  }, []);

  async function createLoop() {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/workflows/internal/loops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task,
          cron,
          timezone,
          integrations: integrations.split(",").map((item) => item.trim()).filter(Boolean),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to create loop");
      const loop = payload.loop as LoopWorkflow;
      setLoops((prev) => [loop, ...prev.filter((item) => item.id !== loop.id)]);
      setSelectedId(loop.id);
      setNotice("Loop saved.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create loop");
    } finally {
      setSaving(false);
    }
  }

  async function runLoop(loopId: string) {
    setRunningId(loopId);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${loopId}/run`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to run loop");
      setNotice(`Run created: ${payload.run?.runId ?? "created"} (${payload.run?.status ?? "unknown"})`);
      await loadLoops();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run loop");
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-6 py-5">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Internal Loop Creator</h1>
              <p className="mt-1 text-sm text-slate-500">Temporary admin surface for creating Boop-style recurring execution loops.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={loadLoops} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-6xl gap-4 px-6 py-6 lg:grid-cols-[380px_1fr]">
        <section className="border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Create loop</h2>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Task</span>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                className="mt-1 min-h-32 w-full border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Cron</span>
              <input
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="mt-1 w-full border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Timezone metadata</span>
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="mt-1 w-full border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Integrations</span>
              <input
                value={integrations}
                onChange={(event) => setIntegrations(event.target.value)}
                className="mt-1 w-full border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <Button type="button" className="w-full rounded-none bg-indigo-600 text-white hover:bg-indigo-700" onClick={createLoop} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Save loop
            </Button>
          </div>
          {notice ? <p className="mt-3 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p> : null}
          {error ? <p className="mt-3 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        </section>

        <section className="min-h-[560px] border border-slate-200 bg-white">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading loops
            </div>
          ) : selected ? (
            <div className="grid h-full lg:grid-cols-[260px_1fr]">
              <aside className="border-r border-slate-200">
                {loops.map((loop) => (
                  <button
                    key={loop.id}
                    type="button"
                    onClick={() => setSelectedId(loop.id)}
                    className={`block w-full border-b border-slate-100 px-3 py-3 text-left text-sm ${selected.id === loop.id ? "bg-indigo-50 text-indigo-900" : "text-slate-700 hover:bg-slate-50"}`}
                  >
                    <span className="block truncate font-medium">{loop.title}</span>
                    <span className="mt-1 block truncate text-xs text-slate-500">{loop.definition.schedule.cron} · {loop.status}</span>
                  </button>
                ))}
              </aside>
              <div className="overflow-auto p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">{selected.title}</h2>
                    <p className="mt-1 text-sm text-slate-500">{selected.definition.goal}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-none bg-slate-900 text-white hover:bg-slate-800"
                    onClick={() => runLoop(selected.id)}
                    disabled={runningId === selected.id}
                  >
                    {runningId === selected.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                    Run
                  </Button>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="border border-slate-200 p-3">
                    <p className="text-xs font-medium text-slate-500">Schedule</p>
                    <p className="mt-1 text-sm text-slate-900">{selected.definition.schedule.cron}</p>
                    <p className="text-xs text-slate-500">{selected.definition.schedule.timezone}</p>
                  </div>
                  <div className="border border-slate-200 p-3">
                    <p className="text-xs font-medium text-slate-500">Next run</p>
                    <p className="mt-1 text-sm text-slate-900">{formatDate(selected.nextRunAt)}</p>
                  </div>
                  <div className="border border-slate-200 p-3">
                    <p className="text-xs font-medium text-slate-500">Scheduler</p>
                    <p className="mt-1 text-sm text-slate-900">{selected.definition.schedulerTarget}</p>
                  </div>
                </div>

                <div className="mt-5">
                  <h3 className="text-sm font-semibold text-slate-900">CEO</h3>
                  <div className="mt-2 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <p className="font-medium text-slate-900">{selected.definition.ceo.task}</p>
                    <p className="mt-2 text-xs text-slate-500">{selected.definition.ceo.policy}</p>
                  </div>
                </div>

                <div className="mt-5">
                  <h3 className="text-sm font-semibold text-slate-900">Auto-spawned agents</h3>
                  <div className="mt-2 grid gap-3">
                    {selected.definition.agents.map((agent, index) => (
                      <div key={agent.id} className="border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900">{index + 1}. {agent.name}</p>
                          <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
                            {agent.integration}:{agent.toolPolicy.allowedTools[0]}
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-slate-600">{agent.task}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">No internal loops yet.</div>
          )}
        </section>
      </main>
    </div>
  );
}

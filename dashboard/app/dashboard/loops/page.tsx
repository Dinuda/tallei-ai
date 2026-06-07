"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Plus } from "lucide-react";

type Loop = {
  id: string;
  title: string;
  status: string;
  definition: {
    goal: string;
    engineVersion?: string;
    builderMeta?: { engineVersion?: string };
    agentGraph?: { children?: Array<{ id: string }> };
  };
  updatedAt: string;
};

export default function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workflows/internal/loops", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to load loops");
      setLoops(Array.isArray(payload.loops) ? payload.loops : []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loops");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function archiveLoop(id: string) {
    const response = await fetch(`/api/workflows/internal/loops/${id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload.error ?? "Failed to archive loop");
      return;
    }
    await load();
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Loops</h1>
          <p className="mt-1 text-sm text-slate-600">Architect-designed v3 loops running on the stable manual runtime.</p>
        </div>
        <Link href="/dashboard/loops/new" className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white">
          <Plus className="size-4" /> New loop
        </Link>
      </header>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      {loading ? (
        <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-slate-500" /></div>
      ) : (
        <section className="grid gap-4 md:grid-cols-2">
          {loops.map((loop) => (
            <article key={loop.id} className="rounded-xl border bg-white p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold text-slate-950">{loop.title}</h2>
                  <p className="mt-2 line-clamp-3 text-sm text-slate-600">{loop.definition.goal}</p>
                </div>
                <button onClick={() => void archiveLoop(loop.id)} className="rounded-lg border p-2 text-slate-500 hover:text-red-700" aria-label="Archive loop">
                  <Archive className="size-4" />
                </button>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                <span>{loop.definition.agentGraph?.children?.length ?? 0} agents</span>
                <span>loop_engine_v3</span>
              </div>
              <Link href={`/dashboard/loops/${loop.id}`} className="mt-4 block rounded-lg border px-4 py-2 text-center text-sm font-medium text-slate-800">
                Open loop
              </Link>
            </article>
          ))}
          {loops.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-slate-500 md:col-span-2">
              No stable v3 loops yet.
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}

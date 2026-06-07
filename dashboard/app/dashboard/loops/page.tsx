"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Archive,
  ArrowRight,
  Bot,
  Calendar,
  Check,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Loop = {
  id: string;
  title: string;
  status: string;
  scheduleRrule?: string;
  nextRunAt?: string | null;
  lastScheduledAt?: string | null;
  createdAt?: string;
  updatedAt: string;
  definition: {
    goal: string;
    engineVersion?: string;
    builderMeta?: { engineVersion?: string; designedBy?: string; preApproved?: boolean };
    schedule?: { cron?: string; timezone?: string };
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name?: string; task?: string }>;
    };
  };
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDay(value: string | null | undefined) {
  if (!value) return "Manual";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Manual";
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

function cadenceLabel(loop: Loop) {
  const cron = loop.definition.schedule?.cron ?? loop.scheduleRrule ?? "";
  if (!cron.trim()) return "Manual run";
  if (/0\s+9\s+\*\s+\*\s+1/.test(cron)) return "Weekly rhythm";
  if (/0\s+9\s+\*\s+\*/.test(cron)) return "Daily rhythm";
  return "Manual rhythm";
}

function loopDescription(loop: Loop) {
  return loop.definition.goal || loop.title;
}

function LoopCard({
  loop,
  onArchive,
  archiving,
}: {
  loop: Loop;
  onArchive: (id: string) => Promise<void>;
  archiving: boolean;
}) {
  const agents = loop.definition.agentGraph?.children ?? [];
  const nextInDays = daysUntil(loop.nextRunAt);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
    >
      <Card className="group relative overflow-hidden border-slate-200 bg-white/90 p-0 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-fuchsia-400 opacity-80" />
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="border-0 bg-slate-100 text-slate-700">
                  {loop.status}
                </Badge>
                <Badge variant="secondary" className="border-0 bg-blue-50 text-blue-700">
                  loop_engine_v3
                </Badge>
              </div>
              <h2 className="mt-3 line-clamp-2 text-lg font-semibold text-slate-950">{loop.title}</h2>
              <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">{loopDescription(loop)}</p>
            </div>
            <button
              onClick={() => void onArchive(loop.id)}
              disabled={archiving}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:opacity-40"
              aria-label="Archive loop"
            >
              {archiving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </button>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2 rounded-2xl bg-slate-50 p-2 text-xs">
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <p className="text-slate-400">Cadence</p>
              <p className="mt-1 font-semibold text-slate-800">{cadenceLabel(loop)}</p>
            </div>
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <p className="text-slate-400">Agents</p>
              <p className="mt-1 font-semibold text-slate-800">{agents.length}</p>
            </div>
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <p className="text-slate-400">Next</p>
              <p className="mt-1 font-semibold text-slate-800">
                {nextInDays === null ? "Manual" : nextInDays === 0 ? "Today" : `${nextInDays}d`}
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Clock className="size-3.5" />
              Updated {formatDate(loop.updatedAt)}
            </div>
            <Link
              href={`/dashboard/loops/${loop.id}`}
              className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Open loop <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

function RhythmFooterTimeline({ loops }: { loops: Loop[] }) {
  const items = loops.slice(0, 5);
  if (items.length === 0) return null;

  return (
    <Card className="overflow-hidden border-slate-200 bg-white/80 p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Loop rhythm</p>
          <p className="text-sm text-slate-500">Your saved manual v3 loops, ordered by latest activity.</p>
        </div>
        <Calendar className="size-5 text-slate-400" />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-5">
        {items.map((loop) => (
          <div key={loop.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-400">{formatDay(loop.updatedAt)}</p>
            <p className="mt-1 line-clamp-2 text-sm font-semibold text-slate-900">{loop.title}</p>
            <p className="mt-2 text-xs text-slate-500">{formatDate(loop.updatedAt)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const agentCount = loops.reduce((sum, loop) => sum + (loop.definition.agentGraph?.children?.length ?? 0), 0);
    return {
      loops: loops.length,
      agents: agentCount,
      active: loops.filter((loop) => loop.status === "active").length,
    };
  }, [loops]);

  async function archiveLoop(id: string) {
    setArchivingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to archive loop");
      await load();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Failed to archive loop");
    } finally {
      setArchivingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.12),_transparent_34%),linear-gradient(180deg,#f8fafc_0%,#ffffff_42%)]">
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-3 py-1 text-xs font-medium text-blue-700 shadow-sm">
              <Sparkles className="size-3.5" />
              Stable v3 runtime
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
              Loops
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Architect-designed loops that now run through the durable manual runtime. The dashboard shows state and accepts explicit operator actions only.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void load()} disabled={refreshing}>
              {refreshing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              Refresh
            </Button>
            <Button asChild>
              <Link href="/dashboard/loops/new">
                <Plus className="mr-2 size-4" />
                New loop
              </Link>
            </Button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          {[
            { label: "Saved loops", value: stats.loops, icon: Archive },
            { label: "Active loops", value: stats.active, icon: Check },
            { label: "Runtime agents", value: stats.agents, icon: Bot },
          ].map((item) => (
            <Card key={item.label} className="border-slate-200 bg-white/80 p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">{item.label}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{item.value}</p>
                </div>
                <div className="grid size-10 place-items-center rounded-2xl bg-slate-100 text-slate-600">
                  <item.icon className="size-5" />
                </div>
              </div>
            </Card>
          ))}
        </section>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
        ) : null}

        {loading ? (
          <div className="flex min-h-80 items-center justify-center">
            <Loader2 className="size-7 animate-spin text-slate-500" />
          </div>
        ) : (
          <>
            <section className={cn("grid gap-5", loops.length > 1 ? "lg:grid-cols-2" : "")}>
              {loops.map((loop) => (
                <LoopCard
                  key={loop.id}
                  loop={loop}
                  onArchive={archiveLoop}
                  archiving={archivingId === loop.id}
                />
              ))}
              {loops.length === 0 ? (
                <Card className="border-dashed border-slate-300 bg-white/70 p-10 text-center">
                  <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-500">
                    <Sparkles className="size-5" />
                  </div>
                  <h2 className="mt-4 text-lg font-semibold text-slate-950">No stable loops yet</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
                    Create a v3 loop from the architect flow. Legacy definitions are archived and cannot execute.
                  </p>
                  <Button asChild className="mt-5">
                    <Link href="/dashboard/loops/new">Create loop</Link>
                  </Button>
                </Card>
              ) : null}
            </section>
            <RhythmFooterTimeline loops={loops} />
          </>
        )}
      </div>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { FaTelegramPlane } from "react-icons/fa";
import { MdMarkEmailRead } from "react-icons/md";
import {
  AlertCircle,
  Calendar,
  Check,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Image from "next/image";
import { apiFetch } from "@/lib/api-fetch";
import { useWorkspace } from "@/lib/workspace-context";

/* ------------------------------------------------------------------ */
// Types
/* ------------------------------------------------------------------ */

type Platform = "claude" | "chatgpt";

type Conversation = {
  id: string;
  title: string;
  date: string;
  platform: Platform;
  snippet: string;
};

type LoopMemory = {
  id: string;
  text: string;
  date: string;
  platform: Platform;
  reason?: string;
};

type LoopInsight = {
  id: string;
  name: string;
  description: string;
  workspaceId?: string | null;
  primarySourceFile: string;
  frequency: string;
  conversationCount: number;
  lastOccurred: string;
  nextPredicted: string;
  confidence: number;
  status: "detected" | "looped" | "dismissed";
  conversations: Conversation[];
  memories?: LoopMemory[];
};

type Loop = {
  id: string;
  title: string;
  status: string;
  goal?: string;
  scheduleRrule?: string;
  nextRunAt?: string | null;
  lastScheduledAt?: string | null;
  createdAt?: string;
  updatedAt: string;
  definitionVersion?: string;
  definition?: {
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

type LoopWorkspace = {
  id: string;
  name: string;
  description: string | null;
};

type ActiveChannel = {
  id: string;
  kind: "telegram" | "gmail" | "email";
  destination: string;
  isPrimary: boolean;
  enabled: boolean;
  label: string | null;
};

/* ------------------------------------------------------------------ */
// Helpers
/* ------------------------------------------------------------------ */

function formatDate(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function formatExactDateTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDay(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: "short" });
  } catch {
    return "";
  }
}

function daysUntil(ts: string): number {
  try {
    const diff = new Date(ts).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

function addDays(baseIso: string, days: number): string {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return new Date().toISOString();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededRandom(seed: string): number {
  const x = Math.sin(hashString(seed)) * 10000;
  return x - Math.floor(x);
}

function platformStyle(platform: Platform): {
  bg: string;
  text: string;
  label: string;
  iconPath: string;
} {
  if (platform === "claude") {
    return { bg: "#D97757", text: "#fff", label: "Claude", iconPath: "/claude.svg" };
  }
  return { bg: "#10a37f", text: "#fff", label: "ChatGPT", iconPath: "/chatgpt.svg" };
}

const ACCENT = "#4338ca";

function mapDatabaseLoopToInsight(loop: Loop): LoopInsight {
  const agents = loop.definition?.agentGraph?.children ?? [];
  
  const allMemories = agents.map((agent, i) => ({
    id: agent.id || `agent-${i}`,
    text: agent.task || agent.name || "Agent task",
    date: loop.updatedAt || new Date().toISOString(),
    platform: (agent.name?.toLowerCase().includes("claude") || agent.task?.toLowerCase().includes("claude")) ? "claude" as const : "chatgpt" as const,
    reason: agent.name,
  }));

  const memories = allMemories.filter((mem, index, self) => 
    index === self.findIndex((t) => t.text.trim().toLowerCase() === mem.text.trim().toLowerCase())
  );

  const pastDates = [
    addDays(loop.updatedAt || new Date().toISOString(), -14),
    addDays(loop.updatedAt || new Date().toISOString(), -7),
    loop.updatedAt || new Date().toISOString(),
  ];
  
  const conversations = pastDates.map((d, i) => ({
    id: `conv-${i}`,
    title: `Run ${i + 1}`,
    date: d,
    platform: "chatgpt" as Platform,
    snippet: "Historical run",
  }));

  let frequency = "Manual";
  const cron = loop.definition?.schedule?.cron ?? loop.scheduleRrule ?? "";
  if (cron.trim()) {
    if (/0\s+9\s+\*\s+\*\s+1/.test(cron)) frequency = "Weekly";
    else if (/0\s+9\s+\*\s+\*/.test(cron)) frequency = "Daily";
    else frequency = "Scheduled";
  }

  return {
    id: loop.id,
    name: loop.title,
    description: loop.goal || loop.definition?.goal || loop.title,
    workspaceId: null,
    primarySourceFile: "workflow",
    frequency,
    conversationCount: agents.length,
    lastOccurred: loop.lastScheduledAt || loop.updatedAt || new Date().toISOString(),
    nextPredicted: loop.nextRunAt || addDays(loop.updatedAt || new Date().toISOString(), 7),
    confidence: 100,
    status: loop.status === "active" ? "looped" : "detected",
    conversations,
    memories,
  };
}

/* ------------------------------------------------------------------ */
// Memory Deck — horizontal overlap
/* ------------------------------------------------------------------ */

function MemoryDeck({ memories }: { memories: LoopMemory[] }) {
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);

  // Filter memories to a max of 3 to fit nicely horizontally
  const displayMemories = memories.slice(0, 3);

  return (
    <div className="relative mx-auto flex h-32 w-full max-w-[320px] items-center justify-center">
      {displayMemories.map((memory, index) => {
        const isCardHovered = hoveredCardId === memory.id;
        const ps = platformStyle(memory.platform);
        
        // Z-index should go 0, 1, 2... so rightmost is on top
        const zIndex = isCardHovered ? 200 : index;
        
        // Overlap shift left/right
        const total = displayMemories.length;
        const offset = index - (total - 1) / 2;
        const xOffset = offset * 46;

        return (
          <TooltipProvider key={memory.id} delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0, x: xOffset }}
                  whileHover={{ scale: 1.03, y: -5 }}
                  onMouseEnter={() => setHoveredCardId(memory.id)}
                  onMouseLeave={() =>
                    setHoveredCardId((current) => (current === memory.id ? null : current))
                  }
                  transition={{ type: "spring", stiffness: 300, damping: 25, delay: index * 0.05 }}
                  className="absolute"
                  style={{ zIndex }}
                >
                  <Card className="h-[105px] w-[145px] rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
                    <div className="mb-2 flex items-center justify-between gap-1">
                      <span
                        className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[9px] font-semibold"
                        style={{ background: ps.bg, color: ps.text }}
                      >
                        <Image
                          src={ps.iconPath}
                          alt={`${ps.label} icon`}
                          width={10}
                          height={10}
                          className="h-2.5 w-2.5 rounded-[2px] bg-white/90 p-[1px]"
                        />
                        {ps.label}
                      </span>
                      <span className="text-[9px] font-medium text-slate-500">
                        {formatDate(memory.date)}
                      </span>
                    </div>
                    <p className="line-clamp-4 text-[10px] font-medium leading-[1.35] text-slate-700">
                      {memory.text}
                    </p>
                  </Card>
                </motion.div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[200px]">
                <p className="text-xs font-medium">{memory.text}</p>
                {memory.reason ? <p className="mt-0.5 text-[11px] text-white/70">{memory.reason}</p> : null}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
// Creative Timeline straight lines
/* ------------------------------------------------------------------ */

function CreativeTimeline({
  conversations,
  nextPredicted,
  loopId,
}: {
  conversations: Conversation[];
  nextPredicted: string;
  loopId: string;
}) {
  const items = useMemo(() => {
    const sorted = [...conversations].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    return [
      ...sorted.map((c) => ({ ...c, kind: "past" as const })),
      {
        id: "next",
        title: "Next",
        date: nextPredicted,
        platform: "claude" as Platform,
        snippet: "Tallei will prepare this",
        kind: "future" as const,
      },
    ];
  }, [conversations, nextPredicted]);

  const count = items.length;
  const width = 280;
  const height = 40;
  const padding = 20;
  const usableWidth = width - padding * 2;
  const step = usableWidth / Math.max(1, count - 1);

  const pathPoints = items.map((_, i) => {
    const x = padding + i * step;
    let y = height / 2;
    if (i === 0) y = height - 5;
    else if (i === 1) y = 10;
    else if (i === 2) y = 10;
    else y = height - 10;
    return { x, y };
  });

  const pathD = pathPoints.reduce((acc, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    return `${acc} L ${p.x} ${p.y}`;
  }, "");

  return (
    <svg width={width} height={height + 24} viewBox={`0 0 ${width} ${height + 24}`} className="mx-auto block overflow-visible">
      <motion.path
        d={pathD}
        fill="none"
        stroke="#cbd5e1"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />

      {items.map((item, i) => {
        const p = pathPoints[i];
        const isFuture = item.kind === "future";
        return (
          <g key={item.id}>
            <circle
              cx={p.x}
              cy={p.y}
              r={isFuture ? 7 : 6}
              fill="#fff"
              stroke={isFuture ? ACCENT : "#cbd5e1"}
              strokeWidth={2}
            />
            {isFuture ? (
              <motion.circle
                cx={p.x}
                cy={p.y}
                r={3}
                fill={ACCENT}
                animate={{ r: [3, 4, 3] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
            ) : (
              <circle cx={p.x} cy={p.y} r={2} fill="#cbd5e1" />
            )}
            <text
              x={p.x}
              y={height + 16}
              textAnchor="middle"
              className={isFuture ? "fill-[var(--text)] font-semibold" : "fill-[var(--text-muted)]"}
              style={{ fontSize: 9, fontFamily: "inherit" }}
            >
              {isFuture ? formatDay(item.date) : formatDate(item.date)}
            </text>
            <rect
              x={p.x - 14}
              y={p.y - 14}
              width={28}
              height={28}
              fill="transparent"
              cursor="default"
            >
              <title>{item.title}{"\n"}{isFuture ? "Predicted" : formatDate(item.date)}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
// Loop Card
/* ------------------------------------------------------------------ */

function LoopCard({
  loop,
  index,
  onDismiss,
  onLoop,
  running,
  actionLabel = "Loop this",
}: {
  loop: LoopInsight;
  index: number;
  onDismiss: (id: string) => void;
  onLoop: (id: string) => Promise<void> | void;
  running?: boolean;
  actionLabel?: string;
}) {
  const [looped, setLooped] = useState(loop.status === "looped");
  const days = daysUntil(loop.nextPredicted);
  const memories = loop.memories?.length ? loop.memories : loop.conversations.map((conversation) => ({
    id: conversation.id,
    text: conversation.snippet,
    date: conversation.date,
    platform: conversation.platform,
  }));

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 24, delay: index * 0.08 }}
    >
      <Card className="group relative overflow-hidden rounded-none border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-none border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm">
              <RotateCcw size={12} className="text-slate-500" />
              {loop.frequency}
              {looped && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-xs">Ritual active</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {days <= 3 && days > 0 && (
              <div className="flex items-center gap-1 rounded-none bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
                <Clock size={10} />
                {formatExactDateTime(loop.nextPredicted)}
              </div>
            )}
            <button
              onClick={() => onDismiss(loop.id)}
              className="grid h-7 w-7 place-items-center rounded-none text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Title */}
        <div className="mb-4">
          <h3 className="text-xl font-bold text-[var(--text)] line-clamp-2 min-h-[3.5rem]">{loop.name}</h3>
        </div>

        {/* Memory Deck */}
        <div className="mb-3">
          <MemoryDeck memories={memories} />
        </div>

        {/* Timeline */}
        <div className="mb-3 flex justify-center">
          <CreativeTimeline
            conversations={loop.conversations}
            nextPredicted={loop.nextPredicted}
            loopId={loop.id}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-light)] pt-5">
          <div className="flex items-center gap-2 text-xs text-[var(--text-2)]">
            <Calendar size={14} className="text-[var(--text-muted)]" />
            {days > 0 ? (
              <span>
                Next in <span className="font-semibold text-[var(--text)]">{days} days</span>
              </span>
            ) : (
              <span className="font-semibold" style={{ color: ACCENT }}>
                Due today
              </span>
            )}
          </div>

          <Button
            onClick={() => onLoop(loop.id)}
            disabled={running}
            className="h-9 gap-2 rounded-none px-4 text-sm font-medium text-white shadow-sm transition-all hover:brightness-110 hover:shadow-md active:scale-95"
            style={{ backgroundColor: ACCENT }}
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            Open loop
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
// Rhythm — compact uptime-style bar chart
/* ------------------------------------------------------------------ */

function RhythmFooterTimeline({ loops }: { loops: LoopInsight[] }) {
  const nextDays = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 30 }).map((_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      return d;
    });
  }, []);

  const scheduledByDay = useMemo(() => {
    return nextDays.map((dayDate) => {
      const dayTimestamp = dayDate.getTime();
      const scheduledLoops = loops.filter((loop) => {
        const loopNext = new Date(loop.nextPredicted);
        loopNext.setHours(0, 0, 0, 0);
        
        if (loopNext.getTime() === dayTimestamp) return true;
        if (loop.frequency === "Daily" && loopNext.getTime() <= dayTimestamp) return true;
        if (loop.frequency === "Weekly" && loopNext.getDay() === dayDate.getDay() && loopNext.getTime() <= dayTimestamp) return true;
        
        return false;
      });
      return {
        date: dayDate,
        loops: scheduledLoops,
      };
    });
  }, [nextDays, loops]);

  return (
    <footer className="border-t border-[var(--border-light)] px-6 pt-8 pb-4">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-bold text-[var(--text)]">Your rhythm</span>
          <span className="text-[11px] font-medium text-[var(--text-muted)]">30-day activity</span>
        </div>

        {/* Bar chart */}
        <div className="mb-2 flex w-full items-center gap-[3px]">
          {scheduledByDay.map((day, i) => {
            const isEmpty = day.loops.length === 0;

            return (
              <Dialog key={i}>
                <DialogTrigger asChild>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`h-6 min-w-0 flex-1 cursor-pointer rounded-[2px] transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 ${
                      isEmpty ? "bg-slate-200" : "bg-[#94a3b8]"
                    }`}
                    style={
                      isEmpty
                        ? undefined
                        : { opacity: Math.min(1, 0.4 + day.loops.length * 0.2) }
                    }
                    aria-label={`View schedule for ${day.date.toDateString()}`}
                  />
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl overflow-hidden p-0">
                  <DialogHeader className="border-b border-slate-100 px-6 py-4">
                    <DialogTitle className="text-lg font-bold text-slate-900">
                      Scheduled for {day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                    </DialogTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      {day.loops.length} {day.loops.length === 1 ? "loop" : "loops"} scheduled for this day
                    </p>
                  </DialogHeader>
                  <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
                    {day.loops.length > 0 ? (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {day.loops.map((loop) => (
                          <div key={loop.id} className="group relative flex items-start gap-4 rounded-none border border-slate-200 bg-white p-4 shadow-sm transition-all hover:border-[#4338ca]/30 hover:shadow-md">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-none bg-indigo-50 text-[#4338ca] ring-1 ring-inset ring-indigo-100/50">
                              <Calendar size={16} />
                            </div>
                             <div className="min-w-0 flex-1">
                               <h4 className="truncate text-sm font-semibold text-slate-900">{loop.name}</h4>
                               <p className="mt-0.5 truncate text-xs text-slate-500">{loop.frequency}</p>
                             </div>
                             <div className="absolute right-4 top-4 opacity-0 transition-opacity group-hover:opacity-100">
                               <span className="text-[#4338ca]">
                                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                               </span>
                             </div>
                           </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-50">
                          <Check size={20} className="text-slate-400" />
                        </div>
                        <p className="text-sm font-medium text-slate-900">A quiet day</p>
                        <p className="text-xs text-slate-500">Nothing scheduled for this day.</p>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
            );
          })}
        </div>

        {/* Date labels */}
        <div className="flex items-center justify-between text-[10px] font-medium text-[var(--text-muted)]">
          <span>Today</span>
          <span>In 30 days</span>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
// Main Page
/* ------------------------------------------------------------------ */

export default function LoopsPage() {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const [loops, setLoops] = useState<LoopInsight[]>([]);
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loopActionError, setLoopActionError] = useState<string | null>(null);
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);

  const loadLoops = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loopsResponse, channelsResponse] = await Promise.all([
        apiFetch("/api/workflows/internal/loops", { cache: "no-store" }),
        apiFetch("/api/channels", { cache: "no-store" }),
      ]);
      const loopsPayload = await loopsResponse.json().catch(() => ({}));
      const channelsPayload = await channelsResponse.json().catch(() => ({}));

      if (!loopsResponse.ok) throw new Error(loopsPayload.error ?? "Failed to load loops");
      if (channelsResponse.ok) {
        const channels = Array.isArray(channelsPayload.channels) ? channelsPayload.channels as ActiveChannel[] : [];
        const primaryChannel = channels.find((channel) => channel.enabled && channel.isPrimary)
          ?? channels.find((channel) => channel.enabled && (channel.kind === "gmail" || channel.kind === "email"));
        setActiveChannel(primaryChannel ?? null);
      }

      const dbLoops = Array.isArray(loopsPayload.loops) ? loopsPayload.loops as Loop[] : [];
      setLoops(dbLoops.map(mapDatabaseLoopToInsight));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loops");
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace?.id]);

  useEffect(() => {
    void loadLoops();
  }, [loadLoops]);

  const dismissLoop = useCallback((id: string) => {
    setLoops((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const activateLoop = useCallback(async (id: string) => {
    setLoopActionError(null);
    setRunningLoopId(id);
    try {
      router.push(`/dashboard/loops/${id}`);
    } catch (activateError) {
      setLoopActionError(activateError instanceof Error ? activateError.message : "Failed to open loop");
    } finally {
      setRunningLoopId(null);
    }
  }, [router]);

  const filtered = useMemo(() => {
    return filter === "high"
      ? loops.filter((l) => l.confidence >= 80)
      : filter === "medium"
      ? loops.filter((l) => l.confidence >= 60 && l.confidence < 80)
      : loops;
  }, [loops, filter]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-[calc(100vh-72px)] flex-col bg-[#f8fafc]">
        {/* Header */}
        <header className="mx-auto flex w-full max-w-5xl flex-wrap items-end justify-between gap-4 border-b border-[var(--border-light)] py-8 px-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">Loops</h1>
            <p className="mt-1 text-sm text-[var(--text-2)]">
              Patterns Tallei noticed in your work
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => router.push("/dashboard/loops/new")}
              className="h-9 gap-1.5 rounded-none shadow-sm bg-orange-500 hover:bg-orange-600 text-white"
              title="Open the loop builder to design or edit a loop"
            >
              <Plus size={14} />
              New loop
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 gap-1.5 rounded-none shadow-sm bg-white"
              onClick={loadLoops}
              disabled={loading}
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </Button>
          </div>
        </header>

        {/* Main stage */}
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {error ? (
            <div className="mx-auto mb-6 max-w-5xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {error}
              </span>
            </div>
          ) : null}
          {loopActionError ? (
            <div className="mx-auto mb-6 max-w-5xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {loopActionError}
              </span>
            </div>
          ) : null}

          <div className="mx-auto mb-8 flex max-w-5xl flex-wrap items-center justify-between gap-4">
            <div className="text-sm text-slate-500">
              Showing loops in <span className="font-medium text-slate-800">{activeWorkspace?.name ?? "workspace"}</span>
            </div>
            
            <div
              className={`inline-flex items-center gap-2 rounded-none border px-3 py-1.5 text-xs shadow-sm transition ${
                activeChannel
                  ? activeChannel.kind === "telegram"
                    ? "border-sky-200 bg-sky-50"
                    : "border-indigo-200 bg-indigo-50"
                  : "border-slate-200 bg-white"
              }`}
            >
              <span
                className={`grid h-3.5 w-3.5 place-items-center rounded-full ${
                  activeChannel
                    ? activeChannel.kind === "telegram"
                      ? "bg-sky-200 text-sky-600"
                      : "bg-indigo-200 text-indigo-600"
                    : "bg-slate-100"
                }`}
              >
                {activeChannel ? (
                  activeChannel.kind === "telegram" ? (
                    <div className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  ) : (
                    <div className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                  )
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                )}
              </span>
              <span className="text-slate-500">Active channel</span>
              <span className={`max-w-[12rem] truncate font-semibold ${
                activeChannel 
                  ? activeChannel.kind === "telegram" ? "text-sky-900" : "text-indigo-900"
                  : "text-slate-900"
              }`}>
                {activeChannel
                  ? `${activeChannel.kind === "telegram" ? "Telegram" : "Inbox"}`
                  : "None"}
              </span>
            </div>
          </div>

          <AnimatePresence mode="popLayout">
            {filtered.length === 0 && !loading ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full flex-col items-center justify-center gap-5 text-center"
              >
                <div className="grid h-16 w-16 place-items-center rounded-none bg-slate-100 shadow-sm">
                  <Sparkles size={28} className="text-slate-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text)]">
                    Tallei is watching your work
                  </h2>
                  <p className="mt-1 max-w-sm text-sm text-[var(--text-2)]">
                    When a pattern emerges — like a recurring newsletter, a weekly
                    report, or a pre-call brief — it will appear here like a
                    recurring dream.
                  </p>
                </div>
              </motion.div>
            ) : (
              <div className="mx-auto max-w-5xl">
                {/* Cards grid */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                  {filtered.map((loop, i) => (
                    <LoopCard
                      key={loop.id}
                      loop={loop}
                      index={i}
                      onDismiss={dismissLoop}
                      onLoop={activateLoop}
                      running={runningLoopId === loop.id}
                      actionLabel={"Run loop"}
                    />
                  ))}
                </div>
              </div>
            )}
          </AnimatePresence>
        </main>

        {filtered.length > 0 && !loading && <RhythmFooterTimeline loops={filtered} />}
      </div>
    </TooltipProvider>
  );
}

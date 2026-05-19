"use client";

import { useCallback, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Bot,
  Calendar,
  Check,
  Clock,
  RotateCcw,
  Sparkles,
  X,
  Zap,
  MessageCircle,
} from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Image from "next/image";

/* ------------------------------------------------------------------ */
//  Types
/* ------------------------------------------------------------------ */

type Platform = "claude" | "chatgpt";

type Conversation = {
  id: string;
  title: string;
  date: string;
  platform: Platform;
  snippet: string;
};

type LoopInsight = {
  id: string;
  name: string;
  description: string;
  frequency: string;
  conversationCount: number;
  lastOccurred: string;
  nextPredicted: string;
  confidence: number;
  status: "detected" | "looped" | "dismissed";
  conversations: Conversation[];
};

/* ------------------------------------------------------------------ */
//  Mock Data
/* ------------------------------------------------------------------ */

const MOCK_LOOPS: LoopInsight[] = [
  {
    id: "loop-1",
    name: "Friday Newsletter",
    description:
      "You've drafted a company newsletter 4 times. Always Friday afternoon. Always the same warm, founder-tone.",
    frequency: "Every Friday",
    conversationCount: 4,
    lastOccurred: "2026-05-16T16:30:00Z",
    nextPredicted: "2026-05-23T16:00:00Z",
    confidence: 94,
    status: "detected",
    conversations: [
      {
        id: "ep-1",
        title: "Week 18 update",
        date: "2026-04-25T16:15:00Z",
        platform: "claude",
        snippet: "Drafted the weekly company newsletter covering product ship...",
      },
      {
        id: "ep-2",
        title: "Week 19 update",
        date: "2026-05-02T16:20:00Z",
        platform: "chatgpt",
        snippet: "Newsletter draft with customer story highlight and roadmap...",
      },
      {
        id: "ep-3",
        title: "Week 20 update",
        date: "2026-05-09T16:10:00Z",
        platform: "claude",
        snippet: "Founder update: new integrations, team growth, next quarter...",
      },
      {
        id: "ep-4",
        title: "Week 21 update",
        date: "2026-05-16T16:30:00Z",
        platform: "claude",
        snippet: "Product launch week newsletter — metrics, quotes, CTA...",
      },
    ],
  },
  {
    id: "loop-2",
    name: "Product Snapshot",
    description:
      "Twice this month you asked for a 'quick product summary' before a call. Same structure, same context.",
    frequency: "Before key calls",
    conversationCount: 2,
    lastOccurred: "2026-05-14T09:00:00Z",
    nextPredicted: "2026-05-21T09:00:00Z",
    confidence: 71,
    status: "detected",
    conversations: [
      {
        id: "ep-5",
        title: "Pre-investor sync",
        date: "2026-05-07T09:00:00Z",
        platform: "chatgpt",
        snippet: "Generated a one-pager on current product status and metrics...",
      },
      {
        id: "ep-6",
        title: "Pre-partner call",
        date: "2026-05-14T09:00:00Z",
        platform: "claude",
        snippet: "Summarized product features and integration roadmap for...",
      },
    ],
  },
  {
    id: "loop-3",
    name: "Investor Update",
    description:
      "End-of-month investor updates. Tallei noticed the pattern forming — only 2 occurrences so far.",
    frequency: "End of month",
    conversationCount: 2,
    lastOccurred: "2026-04-30T18:00:00Z",
    nextPredicted: "2026-05-31T18:00:00Z",
    confidence: 58,
    status: "detected",
    conversations: [
      {
        id: "ep-7",
        title: "April investor memo",
        date: "2026-03-31T18:00:00Z",
        platform: "chatgpt",
        snippet: "Monthly investor update: revenue, burn, hires, risks...",
      },
      {
        id: "ep-8",
        title: "May investor memo",
        date: "2026-04-30T18:00:00Z",
        platform: "claude",
        snippet: "Investor update with new metrics dashboard and hiring plan...",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
//  Helpers
/* ------------------------------------------------------------------ */

function formatDate(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

/* ------------------------------------------------------------------ */
//  Accent color (only for CTAs and active states)
/* ------------------------------------------------------------------ */

const ACCENT = "#4338ca";

/* ------------------------------------------------------------------ */
//  Conversation Deck — always fanned
/* ------------------------------------------------------------------ */

function ConversationDeck({ conversations }: { conversations: Conversation[] }) {
  const total = conversations.length;
  const [hovered, setHovered] = useState(false);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);

  return (
    <div
      className="relative mx-auto h-40 w-full max-w-[390px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setHoveredCardId(null);
      }}
    >
      {conversations.map((conv, index) => {
        const offset = index - (total - 1) / 2;
        const restRotation =
          (seededRandom(conv.id + "-rot") > 0.5 ? 1 : -1) * (Math.abs(offset) * 0.6 + 0.3);
        const fanRotation = offset * 7;
        const restX = offset * 34;
        const fanX = offset * 58;
        const restY = -index * 3;
        const fanY = Math.abs(offset) * 4;
        const ps = platformStyle(conv.platform);
        const isCardHovered = hoveredCardId === conv.id;

        return (
          <TooltipProvider key={conv.id} delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <motion.div
                  initial={{ opacity: 0, y: 20, rotate: 0 }}
                  animate={{
                    opacity: 1,
                    x: hovered ? fanX : restX,
                    y: hovered ? fanY : restY,
                    rotate: hovered ? fanRotation : restRotation,
                  }}
                  whileHover={{ scale: 1.04 }}
                  onMouseEnter={() => setHoveredCardId(conv.id)}
                  onMouseLeave={() =>
                    setHoveredCardId((current) => (current === conv.id ? null : current))
                  }
                  transition={{
                    type: "spring",
                    stiffness: hovered ? 300 : 260,
                    damping: hovered ? 20 : 24,
                    delay: index * 0.04,
                  }}
                  className="absolute left-1/2 top-1 w-[174px]"
                  style={{ marginLeft: -87, zIndex: isCardHovered ? 200 : index }}
                >
                  <Card className="border-[var(--border-light)] p-3 shadow-sm">
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: ps.bg, color: ps.text }}
                      >
                        <Image
                          src={ps.iconPath}
                          alt={`${ps.label} icon`}
                          width={12}
                          height={12}
                          className="h-3 w-3 rounded-[2px] bg-white/90 p-[1px]"
                        />
                        {ps.label}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {formatDate(conv.date)}
                      </span>
                    </div>
                    <p className="truncate text-xs font-medium text-[var(--text)]">
                      {conv.title}
                    </p>
                  </Card>
                </motion.div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[200px]">
                <p className="text-xs font-medium">{conv.title}</p>
                <p className="mt-0.5 text-[11px] text-white/70">{conv.snippet}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
//  Creative Timeline inside card
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
  const width = 260;
  const height = 54;
  const padding = 28;
  const usableWidth = width - padding * 2;
  const step = usableWidth / (count - 1);

  const pathPoints = items.map((_, i) => {
    const x = padding + i * step;
    const wave = Math.sin(i * 1.2 + seededRandom(loopId) * 10) * 8;
    const y = height / 2 + wave;
    return { x, y };
  });

  const pathD = pathPoints.reduce((acc, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    const prev = pathPoints[i - 1];
    const cpx1 = prev.x + step * 0.4;
    const cpy1 = prev.y;
    const cpx2 = p.x - step * 0.4;
    const cpy2 = p.y;
    return `${acc} C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${p.x} ${p.y}`;
  }, "");

  return (
    <svg
      width={width}
      height={height + 16}
      viewBox={`0 0 ${width} ${height + 16}`}
      className="mx-auto block"
    >
      <motion.path
        d={pathD}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={5}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
      <motion.path
        d={pathD}
        fill="none"
        stroke="#cbd5e1"
        strokeWidth={2}
        strokeLinecap="round"
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
              r={9}
              fill={isFuture ? "#fff" : "#f8fafc"}
              stroke={isFuture ? "#0f172a" : "#cbd5e1"}
              strokeWidth={2}
            />
            {isFuture ? (
              <motion.circle
                cx={p.x}
                cy={p.y}
                r={3.5}
                fill={ACCENT}
                animate={{ r: [3.5, 4.5, 3.5] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
            ) : (
              <circle cx={p.x} cy={p.y} r={2.5} fill="#94a3b8" />
            )}
            <text
              x={p.x}
              y={height + 12}
              textAnchor="middle"
              className="fill-[var(--text-muted)]"
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
//  Loop Card
/* ------------------------------------------------------------------ */

function LoopCard({
  loop,
  index,
  onDismiss,
  onLoop,
}: {
  loop: LoopInsight;
  index: number;
  onDismiss: (id: string) => void;
  onLoop: (id: string) => void;
}) {
  const [looped, setLooped] = useState(loop.status === "looped");
  const days = daysUntil(loop.nextPredicted);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 24, delay: index * 0.08 }}
    >
      <Card className="group relative overflow-hidden transition-shadow hover:shadow-md">
        {/* Slate-tinted header band */}
        <div className="flex items-center justify-between bg-slate-50 px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
              <RotateCcw size={11} className="text-slate-500" />
              {loop.frequency}
            </div>
            {days <= 3 && days > 0 && (
              <div className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
                <Clock size={10} />
                Soon
              </div>
            )}
          </div>
          <button
            onClick={() => onDismiss(loop.id)}
            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 opacity-0 transition hover:bg-white hover:text-slate-700 hover:shadow-sm group-hover:opacity-100"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-5 pb-5 pt-3">
          {/* Title + meta */}
          <div className="mb-1">
            <h3 className="text-base font-bold text-[var(--text)]">{loop.name}</h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <MessageCircle size={11} />
              {loop.conversationCount} conversations
            </p>
          </div>

          {/* Deck */}
          <div className="mb-1 mt-4">
            <ConversationDeck conversations={loop.conversations} />
          </div>

          {/* Creative timeline */}
          <div className="mb-2 mt-3 flex justify-center">
            <CreativeTimeline
              conversations={loop.conversations}
              nextPredicted={loop.nextPredicted}
              loopId={loop.id}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border-light)] pt-4">
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-2)]">
              <Calendar size={13} className="text-[var(--text-muted)]" />
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

            {!looped ? (
              <Button
                onClick={() => {
                  setLooped(true);
                  onLoop(loop.id);
                }}
                className="h-8 gap-2 rounded-none px-4 text-sm text-white"
                style={{ backgroundColor: ACCENT }}
              >
                <RotateCcw size={14} />
                Loop this
              </Button>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700">
                <Check size={14} className="text-slate-500" />
                Ritual active
              </div>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
//  Rhythm — compact uptime-style bar chart
/* ------------------------------------------------------------------ */

function RhythmFooterTimeline({ loops }: { loops: LoopInsight[] }) {
  const loopColors: Record<string, string> = {
    "loop-1": "#6366f1",
    "loop-2": "#10b981",
    "loop-3": "#f59e0b",
  };

  // Generate 60 bars
  const bars = useMemo(() => {
    const result: Array<{ status: "ok" | "warn" | "late"; loopId?: string }> = [];
    for (let d = 0; d < 60; d++) {
      const r = seededRandom(`merged:${d}`);
      if (r > 0.94) result.push({ status: "late", loopId: loops[d % loops.length]?.id });
      else if (r > 0.82) result.push({ status: "warn", loopId: loops[d % loops.length]?.id });
      else result.push({ status: "ok", loopId: loops[d % loops.length]?.id });
    }
    return result;
  }, [loops]);

  const upcoming = loops.map((loop) => ({
    name: loop.name,
    days: daysUntil(loop.nextPredicted),
    color: loopColors[loop.id] ?? "#94a3b8",
  }));

  return (
    <footer className="border-t border-[var(--border-light)] px-6 py-5">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--text)]">Your rhythm</span>
          <span className="text-xs text-[var(--text-muted)]">60-day activity</span>
        </div>

        {/* Bar chart */}
        <div className="mb-2 flex items-center gap-[2px]">
          {bars.map((bar, i) => {
            const color = bar.loopId ? loopColors[bar.loopId] ?? "#94a3b8" : "#94a3b8";
            let opacity = 0.15;
            if (bar.status === "late") opacity = 1;
            else if (bar.status === "warn") opacity = 0.65;

            return (
              <TooltipProvider key={i} delayDuration={80}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="h-6 flex-1 rounded-[2px] cursor-default transition hover:brightness-125"
                      style={{ backgroundColor: color, opacity }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-[11px]">
                      {bar.status === "late" ? "High activity" : bar.status === "warn" ? "Moderate" : "Normal"}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })}
        </div>

        {/* Date labels */}
        <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] mb-4">
          <span>60 days ago</span>
          <span>Today</span>
        </div>

        {/* Legend + upcoming */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-[var(--border-light)]">
          <div className="flex items-center gap-3">
            {loops.map((loop) => (
              <div key={loop.id} className="flex items-center gap-1.5">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: loopColors[loop.id] ?? "#94a3b8" }}
                />
                <span className="text-xs text-[var(--text-2)]">{loop.name}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4">
            {upcoming.map((u) => (
              <div key={u.name} className="flex items-center gap-1.5">
                <span className="text-xs text-[var(--text-2)]">
                  {u.name}{" "}
                  <span style={{ color: u.color }}>→</span>{" "}
                  <span className="font-medium text-[var(--text)]">Next in {u.days}d</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
//  Main Page
/* ------------------------------------------------------------------ */

export default function LoopsPage() {
  const [loops, setLoops] = useState<LoopInsight[]>(MOCK_LOOPS);
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");

  const dismissLoop = useCallback((id: string) => {
    setLoops((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const activateLoop = useCallback((id: string) => {
    setLoops((prev) =>
      prev.map((l) => (l.id === id ? { ...l, status: "looped" as const } : l))
    );
  }, []);

  const filtered = useMemo(() => {
    if (filter === "high") return loops.filter((l) => l.confidence >= 80);
    if (filter === "medium") return loops.filter((l) => l.confidence >= 60 && l.confidence < 80);
    return loops;
  }, [loops, filter]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-[calc(100vh-72px)] flex-col">
        {/* Header */}
        <header className="flex mx-auto max-w-5xl w-full flex-wrap items-end justify-between gap-4 border-b py-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">Loops</h1>
            <p className="mt-0.5 text-sm text-[var(--text-2)]">
              Patterns Tallei noticed in your work
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center border border-[var(--border-light)] bg-[var(--muted)] p-0.5">
              {(["all", "high", "medium"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium transition ${
                    filter === f
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                      : "text-[var(--text-muted)] hover:text-[var(--text-2)]"
                  }`}
                >
                  {f === "all" ? "All" : f === "high" ? "High confidence" : "Medium"}
                </button>
              ))}
            </div>

            <Button asChild className="gap-1.5 h-9 bg-orange-500 text-white hover:bg-orange-600 rounded-none">
              <Link href="/dashboard/workflows">
                <Bot size={14} />
                Builder
                <ArrowRight size={12} />
              </Link>
            </Button>
          </div>
        </header>

        {/* Main stage */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--muted)] px-6 py-6">
          <AnimatePresence mode="popLayout">
            {filtered.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full flex-col items-center justify-center gap-5 text-center"
              >
                <div className="grid h-16 w-16 place-items-center rounded-xl bg-slate-100 shadow-sm">
                  <Sparkles size={28} className="text-slate-400" />
                </div>sk
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
                <Button
                  asChild
                  className="gap-2 rounded-full text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  <Link href="/dashboard/workflows">
                    <Zap size={14} />
                    Open workflow builder
                  </Link>
                </Button>
              </motion.div>
            ) : (
              <div className="mx-auto max-w-5xl">
                {/* Cards grid */}
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                  {filtered.map((loop, i) => (
                    <LoopCard
                      key={loop.id}
                      loop={loop}
                      index={i}
                      onDismiss={dismissLoop}
                      onLoop={activateLoop}
                    />
                  ))}
                </div>
              </div>
            )}
          </AnimatePresence>
        </main>

        {filtered.length > 0 && <RhythmFooterTimeline loops={filtered} />}
      </div>
    </TooltipProvider>
  );
}

"use client";

import { useCallback, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Bot,
  Calendar,
  Check,
  Clock,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
//  Types
/* ------------------------------------------------------------------ */

type Platform = "claude" | "chatgpt";

type Episode = {
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
  episodeCount: number;
  lastOccurred: string;
  nextPredicted: string;
  confidence: number;
  status: "detected" | "looped" | "dismissed";
  episodes: Episode[];
  threadPath: string;
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
    episodeCount: 4,
    lastOccurred: "2026-05-16T16:30:00Z",
    nextPredicted: "2026-05-23T16:00:00Z",
    confidence: 94,
    status: "detected",
    episodes: [
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
    threadPath:
      "M 20 80 Q 45 65 70 82 Q 95 98 120 78 Q 145 58 170 80",
  },
  {
    id: "loop-2",
    name: "Product Snapshot",
    description:
      "Twice this month you asked for a 'quick product summary' before a call. Same structure, same context.",
    frequency: "Before key calls",
    episodeCount: 2,
    lastOccurred: "2026-05-14T09:00:00Z",
    nextPredicted: "2026-05-21T09:00:00Z",
    confidence: 71,
    status: "detected",
    episodes: [
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
    threadPath: "M 20 80 Q 50 55 80 80 Q 110 105 140 80",
  },
  {
    id: "loop-3",
    name: "Investor Update",
    description:
      "End-of-month investor updates. Tallei noticed the pattern forming — only 2 occurrences so far.",
    frequency: "End of month",
    episodeCount: 2,
    lastOccurred: "2026-04-30T18:00:00Z",
    nextPredicted: "2026-05-31T18:00:00Z",
    confidence: 58,
    status: "detected",
    episodes: [
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
    threadPath: "M 20 80 Q 50 60 80 80 Q 110 100 140 80",
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

function platformIcon(platform: Platform) {
  return platform === "claude" ? (
    <span className="text-[10px] font-bold text-[#d97757]">C</span>
  ) : (
    <span className="text-[10px] font-bold text-[#10a37f]">G</span>
  );
}

/* ------------------------------------------------------------------ */
//  Components
/* ------------------------------------------------------------------ */

function WaxSeal({
  looped,
  onClick,
}: {
  looped: boolean;
  onClick?: () => void;
}) {
  if (looped) {
    return (
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex items-center gap-1.5 rounded-full border border-[#bbf7d0] bg-[#ecfdf5] px-3 py-1.5 text-xs font-semibold text-[#166534]"
      >
        <Check size={12} />
        Ritual active
      </motion.div>
    );
  }

  return (
    <motion.button
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      className="group relative flex items-center gap-2"
    >
      <div className="relative grid h-10 w-10 place-items-center rounded-full bg-[#7eb71b] shadow-md transition group-hover:shadow-lg">
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.25),transparent_60%)]" />
        <Sparkles size={16} className="relative text-white" />
      </div>
      <span className="text-xs font-semibold text-[var(--text)]">
        Make this a ritual
      </span>
    </motion.button>
  );
}

function EpisodeCard({
  episode,
  index,
  total,
  hovered,
}: {
  episode: Episode;
  index: number;
  total: number;
  hovered: boolean;
}) {
  const center = (total - 1) / 2;
  const offset = index - center;

  const restRotation = (seededRandom(episode.id + "-rot") > 0.5 ? 1 : -1) * (Math.abs(offset) * 0.6 + 0.3);
  const restX = offset * 2;
  const restY = -index * 3;

  const fanRotation = offset * 7;
  const fanX = offset * 55;
  const fanY = -Math.abs(offset) * 8;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.div
            animate={{
              rotate: hovered ? fanRotation : restRotation,
              x: hovered ? fanX : restX,
              y: hovered ? fanY : restY,
              zIndex: total - index,
            }}
            transition={{ type: "spring", stiffness: 280, damping: 24 }}
            className="absolute left-1/2 top-0 w-40 cursor-default"
            style={{ marginLeft: -80 }}
          >
            <Card className="border-[var(--border-light)] p-3 shadow-sm">
              <div className="mb-1.5 flex items-center gap-1.5">
                <div className="grid h-5 w-5 place-items-center rounded-md bg-[var(--muted)]">
                  {platformIcon(episode.platform)}
                </div>
                <span className="text-[10px] font-medium text-[var(--text-muted)]">
                  {formatDate(episode.date)}
                </span>
              </div>
              <p className="truncate text-xs font-medium text-[var(--text)]">
                {episode.title}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-2)]">
                {episode.snippet}
              </p>
            </Card>
          </motion.div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px]">
          <p className="text-xs font-medium">{episode.title}</p>
          <p className="mt-0.5 text-[11px] text-white/70">{episode.snippet}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function RhythmStripe({
  episodes,
  nextPredicted,
}: {
  episodes: Episode[];
  nextPredicted: string;
}) {
  const allDates = useMemo(() => {
    const dates = episodes.map((e) => new Date(e.date).getTime());
    dates.push(new Date(nextPredicted).getTime());
    return dates;
  }, [episodes, nextPredicted]);

  const min = Math.min(...allDates);
  const max = Math.max(...allDates);
  const range = max - min || 1;

  const position = (ts: number) => ((ts - min) / range) * 100;

  return (
    <TooltipProvider delayDuration={100}>
      <div className="relative h-8 w-full">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-light)]" />
        {episodes.map((ep) => {
          const pos = position(new Date(ep.date).getTime());
          return (
            <Tooltip key={ep.id}>
              <TooltipTrigger asChild>
                <div
                  className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--text-muted)] cursor-default"
                  style={{ left: `${pos}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs font-medium">{ep.title}</p>
                <p className="text-[11px] text-white/70">{formatDate(ep.date)}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.div
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#7eb71b] bg-white cursor-default"
              style={{ left: `${position(new Date(nextPredicted).getTime())}%`, marginLeft: -6 }}
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs font-medium">Next predicted</p>
            <p className="text-[11px] text-white/70">{formatDate(nextPredicted)}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function EchoStack({
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
  const [hovered, setHovered] = useState(false);
  const [looped, setLooped] = useState(loop.status === "looped");
  const days = daysUntil(loop.nextPredicted);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 40, rotate: (index % 2 === 0 ? -1 : 1) * (seededRandom(loop.id + "-init") * 1.5) }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      transition={{ type: "spring", stiffness: 200, damping: 22, delay: index * 0.1 }}
      className="relative flex flex-col gap-4"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Card className="relative flex flex-col gap-4 overflow-hidden p-5 transition-shadow hover:shadow-md">
        {/* Subtle top accent */}
        <div
          className={`absolute left-0 right-0 top-0 h-0.5 ${
            loop.confidence >= 80
              ? "bg-[#7eb71b]"
              : loop.confidence >= 60
                ? "bg-[var(--text-muted)]"
                : "bg-[var(--border-light)]"
          }`}
        />

        {/* Dismiss */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onDismiss(loop.id)}
          className="absolute right-3 top-3 opacity-0 transition-opacity hover:bg-[var(--muted)] group-hover:opacity-100"
          style={{ opacity: hovered ? 1 : 0 }}
        >
          <X size={12} />
        </Button>

        {/* Header */}
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Badge
              variant={
                loop.confidence >= 80
                  ? "default"
                  : loop.confidence >= 60
                    ? "secondary"
                    : "outline"
              }
            >
              {loop.confidence}% match
            </Badge>
            <span className="text-[10px] text-[var(--text-muted)]">
              {loop.episodeCount} episodes
            </span>
          </div>
          <h3 className="text-base font-bold text-[var(--text)]">{loop.name}</h3>
          <p className="mt-1 max-w-[320px] text-sm leading-relaxed text-[var(--text-2)]">
            {loop.description}
          </p>
        </div>

        {/* Stack visualization */}
        <div className="relative h-44 w-full">
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 200 120"
            preserveAspectRatio="none"
          >
            <motion.path
              d={loop.threadPath}
              fill="none"
              stroke="#7eb71b"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeDasharray={300}
              initial={{ strokeDashoffset: 300 }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: 1.2, delay: index * 0.15 + 0.3, ease: "easeOut" }}
              opacity={0.35}
            />
          </svg>

          <div className="relative mx-auto h-full w-full max-w-[200px]">
            {loop.episodes.map((ep, i) => (
              <EpisodeCard
                key={ep.id}
                episode={ep}
                index={i}
                total={loop.episodes.length}
                hovered={hovered}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
              <Calendar size={11} className="text-[var(--text-muted)]" />
              {loop.frequency}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
              <Clock size={11} className="text-[var(--text-muted)]" />
              {days > 0
                ? `Next in ${days} day${days === 1 ? "" : "s"}`
                : "Due soon"}
            </div>
          </div>

          <WaxSeal
            looped={looped}
            onClick={() => {
              setLooped(true);
              onLoop(loop.id);
            }}
          />
        </div>

        {/* Rhythm stripe */}
        <div className="pt-1">
          <RhythmStripe
            episodes={loop.episodes}
            nextPredicted={loop.nextPredicted}
          />
        </div>
      </Card>
    </motion.div>
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
        <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-[var(--surface)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--muted)]">
              <Sparkles size={18} className="text-[#7eb71b]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-[var(--text)]">Loops</h1>
              <p className="text-xs text-[var(--text-muted)]">
                Patterns Tallei noticed in your work
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-xl border border-[var(--border-light)] bg-[var(--muted)] p-0.5">
              {(["all", "high", "medium"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    filter === f
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                      : "text-[var(--text-muted)] hover:text-[var(--text-2)]"
                  }`}
                >
                  {f === "all"
                    ? "All"
                    : f === "high"
                      ? "High confidence"
                      : "Medium confidence"}
                </button>
              ))}
            </div>

            <Button variant="outline" size="sm" asChild className="gap-1.5">
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
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-[var(--surface)] shadow-sm">
                  <Sparkles size={28} className="text-[var(--text-muted)]" />
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
                <Button asChild className="gap-2 bg-[#7eb71b] text-white hover:bg-[#6a9e18]">
                  <Link href="/dashboard/workflows">
                    <Zap size={14} />
                    Open workflow builder
                  </Link>
                </Button>
              </motion.div>
            ) : (
              <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                {filtered.map((loop, i) => (
                  <EchoStack
                    key={loop.id}
                    loop={loop}
                    index={i}
                    onDismiss={dismissLoop}
                    onLoop={activateLoop}
                  />
                ))}
              </div>
            )}
          </AnimatePresence>
        </main>

        {/* Bottom rhythm stripe (shared) */}
        {filtered.length > 0 && (
          <div className="border-t bg-[var(--surface)] px-6 py-3">
            <div className="mx-auto flex max-w-5xl items-center gap-4">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Your rhythm
              </span>
              <div className="relative h-6 flex-1">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-light)]" />
                {filtered.map((loop) => {
                  const d = daysUntil(loop.nextPredicted);
                  const pos = Math.max(0, Math.min(100, 100 - d * 8));
                  return (
                    <TooltipProvider key={loop.id} delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute top-1/2 flex -translate-y-1/2 flex-col items-center cursor-default"
                            style={{ left: `${pos}%` }}
                          >
                            <span className="mb-1 whitespace-nowrap text-[9px] font-medium text-[var(--text-2)]">
                              {loop.name}
                            </span>
                            <div className="h-2.5 w-2.5 rounded-full bg-[#7eb71b]" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p className="text-xs font-medium">{loop.name}</p>
                          <p className="text-[11px] text-white/70">
                            {d > 0 ? `Next in ${d} days` : "Due soon"} · {loop.confidence}% match
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

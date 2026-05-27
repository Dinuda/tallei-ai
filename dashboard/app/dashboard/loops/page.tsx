"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Calendar,
  Check,
  Clock,
  Loader2,
  RefreshCw,
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
  primarySourceFile: string;
  frequency: string;
  conversationCount: number;
  lastOccurred: string;
  nextPredicted: string;
  confidence: number;
  status: "detected" | "looped" | "dismissed";
  conversations: Conversation[];
};

type LoopMinerEpisode = {
  id: string;
  title?: string;
  summary?: string;
  intent?: string;
  toolNames?: string[];
  eventIds?: string[];
  sealedAt?: string;
  createdAt?: string;
};

type PatternTraceGroup = {
  id: string;
  title: string;
  sharedJob: string;
  sharedArtifact: string;
  episodeIds: string[];
  confidence: number;
};

type LoopMinerSuggestion = {
  id: string;
  title: string;
  reason: string;
  confidence: number;
  triggerCount: number;
  createdAt: string;
  metadata?: unknown;
};

type LoopMinerMemoryDecision = {
  memoryId: string;
  status: "included" | "excluded";
  reason: string;
  contentPreview: string;
  selectedAt?: string;
  sourceImport?: boolean;
  sourceDateTime?: string | null;
  cleanupBucket?: string | null;
  minerImportance?: number;
};

type LoopMinerMemorySelection = {
  considered: number;
  included: number;
  excluded: number;
  sourceImportsIncluded: number;
  unbucketedIncluded: number;
  bucketedExcluded: number;
  decryptFailures: number;
};

type LoopMinerRun = {
  id: string;
  status?: string;
  createdAt: string;
  completedAt: string | null;
  summary?: {
    loopsDetected?: number;
    memorySelection?: LoopMinerMemorySelection;
    memoryDecisionLog?: LoopMinerMemoryDecision[];
    patternTrace?: {
      candidateGroups: PatternTraceGroup[];
      approvedGroups: string[];
      judgeDecisions?: Array<{
        candidateGroupId: string;
        status: string;
        confidence: number;
        rationale: string;
      }>;
    };
  };
  episodes: LoopMinerEpisode[];
  suggestions: LoopMinerSuggestion[];
  loopParents?: Array<{
    id: string;
    subjectAnchor: string;
    confidenceScore: number;
    primarySourceFile: string;
    totalRunsCount: number;
    operationalDomain: "Copywriting" | "System_Design" | "Calculations" | "Visual_Enhancement";
    historicalRuns: Array<{
      id: string;
      episodeId: string;
      text: string;
      score: number;
      metadata: {
        subject_anchor: string;
        operational_domain: "Copywriting" | "System_Design" | "Calculations" | "Visual_Enhancement";
        input_artifact_classes: string[];
        output_artifact_classes: string[];
        category: string | null;
      };
      provenance: {
        platform: string;
        written_at: string;
      };
    }>;
  }>;
};

type LoopMinerRunsPayload = {
  runs?: LoopMinerRun[];
  error?: string;
};

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

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function cadenceLabel(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "Detected pattern";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function inferPlatform(toolNames: string[] | undefined): Platform {
  if ((toolNames ?? []).some((name) => name.toLowerCase().includes("claude"))) return "claude";
  return "chatgpt";
}

function addDays(baseIso: string, days: number): string {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return new Date().toISOString();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

function inferNextPredictionFromCadence(lastOccurred: string, cadence: string): string {
  const text = cadence.toLowerCase();
  if (text.includes("daily")) return addDays(lastOccurred, 1);
  if (text.includes("weekly")) return addDays(lastOccurred, 7);
  if (text.includes("month")) return addDays(lastOccurred, 30);
  return addDays(lastOccurred, 7);
}

function episodeToConversation(episode: LoopMinerEpisode): Conversation {
  return {
    id: episode.id,
    title: episode.title ?? episode.intent ?? "Episode",
    date: episode.sealedAt ?? episode.createdAt ?? new Date().toISOString(),
    platform: inferPlatform(episode.toolNames),
    snippet: episode.summary ?? episode.intent ?? "Built from collaborative activity.",
  };
}

function approvedLoopCount(run: LoopMinerRun): number {
  return run.summary?.loopsDetected
    ?? run.summary?.patternTrace?.approvedGroups.length
    ?? 0;
}

function runHasDisplayableLoopData(run: LoopMinerRun): boolean {
  return (run.suggestions?.length ?? 0) > 0
    || approvedLoopCount(run) > 0
    || (Array.isArray(run.loopParents) && run.loopParents.length > 0)
    || (run.episodes?.length ?? 0) > 0;
}

function pickRunForDisplay(runs: LoopMinerRun[]): LoopMinerRun | null {
  if (runs.length === 0) return null;
  const byRecency = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const withDetectedLoops = byRecency.find((run) => approvedLoopCount(run) > 0);
  if (withDetectedLoops) return withDetectedLoops;
  const withSuggestions = byRecency.find((run) => (run.suggestions?.length ?? 0) > 0);
  if (withSuggestions) return withSuggestions;
  const withLoopParents = byRecency.find((run) => Array.isArray(run.loopParents) && run.loopParents.length > 0);
  if (withLoopParents) return withLoopParents;
  const withLoopData = byRecency.find(runHasDisplayableLoopData);
  if (withLoopData) return withLoopData;
  const completed = byRecency.find((run) => run.status === "completed");
  return completed ?? byRecency[0] ?? null;
}

function episodesForMemoryIds(episodes: LoopMinerEpisode[], memoryIds: string[]): LoopMinerEpisode[] {
  const memorySet = new Set(memoryIds);
  return episodes.filter((episode) =>
    (episode.eventIds ?? []).some((id) => memorySet.has(id))
  );
}

function cleanLoopTitle(raw: string): string {
  const stripped = raw
    .replace(/^Imported ChatGPT memory\s*/i, "")
    .replace(/^Type:\s*\w+\s*/i, "")
    .replace(/^Category:\s*[\w\s]+\s*/i, "")
    .replace(/^Source datetime:\s*[\d-]+\s*/i, "")
    .trim();
  if (stripped.length >= 12) return stripped.length <= 72 ? stripped : `${stripped.slice(0, 69)}...`;
  return raw.length <= 72 ? raw : `${raw.slice(0, 69)}...`;
}

function buildLoopInsightsFromPatternTrace(run: LoopMinerRun): LoopInsight[] {
  const patternTrace = run.summary?.patternTrace;
  if (!patternTrace || patternTrace.approvedGroups.length === 0) return [];

  const approvedSet = new Set(patternTrace.approvedGroups);
  const episodes = run.episodes ?? [];

  return patternTrace.candidateGroups
    .filter((group) => approvedSet.has(group.id))
    .map((group) => {
      const decision = patternTrace.judgeDecisions?.find((item) => item.candidateGroupId === group.id);
      const memoryIds = group.episodeIds;
      const matchedEpisodes = episodesForMemoryIds(episodes, memoryIds);
      const conversations = (matchedEpisodes.length > 0
        ? matchedEpisodes
        : memoryIds.map((memoryId) => ({
            id: memoryId,
            title: cleanLoopTitle(group.title),
            summary: group.sharedJob,
            intent: group.sharedJob,
            toolNames: ["chatgpt"],
            sealedAt: run.completedAt ?? run.createdAt,
          }))
      )
        .sort((a, b) => (b.sealedAt ?? "").localeCompare(a.sealedAt ?? ""))
        .map(episodeToConversation);

      const lastOccurred = conversations
        .map((conversation) => conversation.date)
        .sort((a, b) => b.localeCompare(a))[0] ?? run.completedAt ?? run.createdAt;

      const confidence = Math.max(
        1,
        Math.min(99, Math.round((decision?.confidence ?? group.confidence ?? 0.72) * 100)),
      );

      return {
        id: group.id,
        name: cleanLoopTitle(group.title),
        description: decision?.rationale ?? group.sharedJob,
        primarySourceFile: group.sharedArtifact || "memory",
        frequency: cadenceLabel(group.sharedArtifact),
        conversationCount: Math.max(memoryIds.length, conversations.length),
        lastOccurred,
        nextPredicted: inferNextPredictionFromCadence(lastOccurred, "weekly"),
        confidence,
        status: "detected" as const,
        conversations,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.lastOccurred.localeCompare(a.lastOccurred));
}

function buildLoopInsightsFromRun(run: LoopMinerRun): LoopInsight[] {
  const episodes = run.episodes ?? [];
  const suggestions = run.suggestions ?? [];
  const loopParents = Array.isArray(run.loopParents) ? run.loopParents : [];
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));

  if (suggestions.length > 0) {
    return suggestions.map((suggestion) => {
      const metadata = readRecord(suggestion.metadata);
      const evaluation = readRecord(metadata.evaluation);
      const candidateLoop = readRecord(metadata.candidateLoop);
      const episodeIds = readStringList(candidateLoop.episodeIds ?? evaluation.episodeIds ?? metadata.episodeIds);

      let conversations = episodeIds
        .map((id) => episodeById.get(id))
        .filter((episode): episode is LoopMinerEpisode => Boolean(episode))
        .map(episodeToConversation);

      if (conversations.length === 0) {
        conversations = episodes
          .slice(0, Math.max(1, suggestion.triggerCount))
          .map(episodeToConversation);
      }

      const lastOccurred = conversations
        .map((conversation) => conversation.date)
        .sort((a, b) => b.localeCompare(a))[0] ?? run.completedAt ?? run.createdAt;

      const cadence = cadenceLabel(evaluation.estimatedCadence);
      return {
        id: suggestion.id,
        name: suggestion.title,
        description: suggestion.reason,
        primarySourceFile: conversations[0]?.platform ?? "unknown",
        frequency: cadence,
        conversationCount: Math.max(suggestion.triggerCount, conversations.length),
        lastOccurred,
        nextPredicted: inferNextPredictionFromCadence(lastOccurred, cadence),
        confidence: Math.max(1, Math.min(99, Math.round((suggestion.confidence ?? 0.5) * 100))),
        status: "detected",
        conversations,
      };
    });
  }

  const fromPatternTrace = buildLoopInsightsFromPatternTrace(run);
  if (fromPatternTrace.length > 0) return fromPatternTrace;

  if (loopParents.length > 0) {
    return loopParents.map((parent) => {
      const conversations = parent.historicalRuns.map((run) => ({
        id: run.id,
        title: run.metadata.subject_anchor,
        date: run.provenance.written_at,
        platform: inferPlatform([run.provenance.platform]),
        snippet: run.text || "Historical run",
      }));
      const lastOccurred = conversations
        .map((conversation) => conversation.date)
        .sort((a, b) => b.localeCompare(a))[0] ?? run.completedAt ?? run.createdAt;
      return {
        id: parent.id,
        name: parent.subjectAnchor,
        description: `${parent.operationalDomain.replace(/_/g, " ")} loop`,
        primarySourceFile: parent.primarySourceFile,
        frequency: "Grouped pattern",
        conversationCount: parent.totalRunsCount,
        lastOccurred,
        nextPredicted: inferNextPredictionFromCadence(lastOccurred, "weekly"),
        confidence: Math.max(1, Math.min(99, Math.round(parent.confidenceScore * 100))),
        status: "detected",
        conversations,
      };
    });
  }

  const grouped = new Map<string, LoopMinerEpisode[]>();
  for (const episode of episodes) {
    const key = (episode.intent ?? episode.title ?? "episode").trim().toLowerCase();
    const current = grouped.get(key) ?? [];
    current.push(episode);
    grouped.set(key, current);
  }

  return [...grouped.entries()]
    .map(([key, groupedEpisodes], index) => {
      const conversations = groupedEpisodes
        .sort((a, b) => (b.sealedAt ?? "").localeCompare(a.sealedAt ?? ""))
        .map(episodeToConversation);
      const lastOccurred = conversations[0]?.date ?? run.completedAt ?? run.createdAt;
      return {
        id: `episode-group-${index}-${key}`,
        name: conversations[0]?.title ?? "Detected Episode Pattern",
        description: conversations[0]?.snippet ?? "Pattern inferred from built episodes.",
        primarySourceFile: conversations[0]?.platform ?? "unknown",
        frequency: "Detected pattern",
        conversationCount: conversations.length,
        lastOccurred,
        nextPredicted: inferNextPredictionFromCadence(lastOccurred, "weekly"),
        confidence: 65,
        status: "detected" as const,
        conversations,
      };
    })
    .sort((a, b) => b.lastOccurred.localeCompare(a.lastOccurred));
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

const HARDCODED_NEWSLETTER_TASK = "User is writing a newsletter for xyz product every week. Make that a loop.";

function hardcodedNewsletterLoop(): LoopInsight {
  const now = new Date();
  const last = new Date(now);
  last.setDate(now.getDate() - 7);
  const previous = new Date(now);
  previous.setDate(now.getDate() - 14);
  const next = new Date(now);
  next.setDate(now.getDate() + 7);

  return {
    id: "hardcoded-newsletter-loop-v1",
    name: "Weekly Product Newsletter",
    description: "CEO spawns Topic Researcher, Creative Writer, and Publicist. Publicist only prepares an approval draft.",
    primarySourceFile: "internal loop creator",
    frequency: "Weekly",
    conversationCount: 3,
    lastOccurred: last.toISOString(),
    nextPredicted: next.toISOString(),
    confidence: 99,
    status: "detected",
    conversations: [
      {
        id: "hardcoded-newsletter-research",
        title: "Topic Researcher",
        date: previous.toISOString(),
        platform: "chatgpt",
        snippet: "Researches product context, customer questions, release notes, and competitive references.",
      },
      {
        id: "hardcoded-newsletter-writer",
        title: "Creative Writer",
        date: last.toISOString(),
        platform: "chatgpt",
        snippet: "Turns research into a weekly newsletter draft.",
      },
      {
        id: "hardcoded-newsletter-publicist",
        title: "Publicist",
        date: now.toISOString(),
        platform: "claude",
        snippet: "Prepares the send or publish plan as an approval draft. No external action is committed.",
      },
    ],
  };
}

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
  const [expanded, setExpanded] = useState(false);
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
            <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-[var(--text-muted)]">
              <div className="rounded bg-slate-50 px-2 py-1">Confidence {loop.confidence}%</div>
              <div className="rounded bg-slate-50 px-2 py-1 truncate" title={loop.primarySourceFile}>
                Source {loop.primarySourceFile}
              </div>
              <div className="rounded bg-slate-50 px-2 py-1">{loop.conversationCount} runs</div>
            </div>
          </div>

          <div className="mb-1 mt-4">
            <ConversationDeck conversations={loop.conversations} />
          </div>

          <div className="mb-2 mt-3 flex justify-center">
            <CreativeTimeline
              conversations={loop.conversations}
              nextPredicted={loop.nextPredicted}
              loopId={loop.id}
            />
          </div>

          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-[var(--text-2)] hover:text-[var(--text)]"
          >
            <MessageCircle size={12} />
            {expanded ? "Hide historical runs" : "Show historical runs"}
          </button>
          <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-3 max-h-44 overflow-y-auto border border-[var(--border-light)] bg-white">
                  {loop.conversations
                    .slice()
                    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
                    .map((conversation) => (
                      <div key={conversation.id} className="border-b border-[var(--border-light)] px-3 py-2 text-xs last:border-b-0">
                        <div className="flex items-center justify-between text-[var(--text-muted)]">
                          <span>{formatDate(conversation.date)}</span>
                          <span>{conversation.platform}</span>
                        </div>
                        <div className="mt-1 font-medium text-[var(--text)]">{conversation.title}</div>
                        <div className="mt-0.5 text-[var(--text-2)]">{conversation.snippet}</div>
                      </div>
                    ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

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
                onClick={async () => {
                  try {
                    await onLoop(loop.id);
                    setLooped(true);
                  } catch {
                    setLooped(false);
                  }
                }}
                disabled={running}
                className="h-8 gap-2 rounded-none px-4 text-sm text-white"
                style={{ backgroundColor: ACCENT }}
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                {actionLabel}
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
  const router = useRouter();
  const [loops, setLoops] = useState<LoopInsight[]>([]);
  const [latestRun, setLatestRun] = useState<LoopMinerRun | null>(null);
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loopActionError, setLoopActionError] = useState<string | null>(null);
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);

  const loadLoopMinerRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/memories/cleanup/loop-miner/runs", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as LoopMinerRunsPayload;
      if (!response.ok) throw new Error(payload.error ?? "Failed to load loop miner runs");
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const displayRun = pickRunForDisplay(runs);
      setLatestRun(displayRun);
      const minedLoops = displayRun ? buildLoopInsightsFromRun(displayRun) : [];
      const hardcoded = hardcodedNewsletterLoop();
      setLoops([
        hardcoded,
        ...minedLoops.filter((loop) => loop.id !== hardcoded.id),
      ]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop miner runs");
      setLatestRun(null);
      setLoops([hardcodedNewsletterLoop()]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLoopMinerRuns();
  }, [loadLoopMinerRuns]);

  const dismissLoop = useCallback((id: string) => {
    setLoops((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const activateLoop = useCallback(async (id: string) => {
    setLoopActionError(null);
    setRunningLoopId(id);
    try {
      if (id === "hardcoded-newsletter-loop-v1") {
        router.push("/dashboard/loops/newsletter");
        return;
      }
      setLoops((prev) =>
        prev.map((l) => (l.id === id ? { ...l, status: "looped" as const } : l))
      );
    } catch (activateError) {
      setLoopActionError(activateError instanceof Error ? activateError.message : "Failed to run loop");
      throw activateError;
    } finally {
      setRunningLoopId(null);
    }
  }, [router]);

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
            <Button type="button" variant="outline" className="h-9 gap-1.5" onClick={loadLoopMinerRuns} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </Button>

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
          {error ? (
            <div className="mx-auto mb-4 max-w-5xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {error}
              </span>
            </div>
          ) : null}
          {loopActionError ? (
            <div className="mx-auto mb-4 max-w-5xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {loopActionError}
              </span>
            </div>
          ) : null}
          <AnimatePresence mode="popLayout">
            {filtered.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full flex-col items-center justify-center gap-5 text-center"
              >
                <div className="grid h-16 w-16 place-items-center rounded-xl bg-slate-100 shadow-sm">
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
                      running={runningLoopId === loop.id}
                      actionLabel={loop.id === "hardcoded-newsletter-loop-v1" ? "Open loop" : "Loop this"}
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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { FaTelegramPlane } from "react-icons/fa";
import { MdMarkEmailRead } from "react-icons/md";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  Clock,
  Bot,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Image from "next/image";
import { isLennyNewsletterGoal, isNewsletterLoopDefinition } from "@/lib/lenny-newsletter";

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
  /** Persisted workflow from loop builder / creator */
  isSaved?: boolean;
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

type LoopWorkspace = {
  id: string;
  name: string;
  description: string | null;
};

type LoopWorkflow = {
  id: string;
  title: string;
  workspaceId: string | null;
  status?: string;
  scheduleRrule?: string;
  nextRunAt?: string | null;
  lastScheduledAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  definition?: {
    goal?: string;
    presetId?: string;
    schedule?: { cron?: string; timezone?: string };
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name: string; task: string }>;
    };
    builderMeta?: { designedBy?: string; preApproved?: boolean };
  };
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

function memoryDecisionToLoopMemory(decision: LoopMinerMemoryDecision): LoopMemory {
  return {
    id: decision.memoryId,
    text: decision.contentPreview || "Memory used to detect this loop.",
    date: decision.sourceDateTime ?? decision.selectedAt ?? new Date().toISOString(),
    platform: decision.sourceImport ? "chatgpt" : "claude",
    reason: decision.reason,
  };
}

function memoriesForIds(run: LoopMinerRun, memoryIds: string[]): LoopMemory[] {
  const memoryIdSet = new Set(memoryIds);
  const decisions = run.summary?.memoryDecisionLog ?? [];
  const matched = decisions
    .filter((decision) => decision.status === "included" && memoryIdSet.has(decision.memoryId))
    .map(memoryDecisionToLoopMemory);

  if (matched.length > 0) return matched;

  return memoryIds.map((memoryId) => ({
    id: memoryId,
    text: "Memory used to detect this loop.",
    date: run.completedAt ?? run.createdAt,
    platform: "chatgpt" as Platform,
  }));
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
      const memories = memoriesForIds(run, memoryIds);
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
        memories,
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
      const memories = memoriesForIds(run, episodeIds);

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
        memories,
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
      const memories = parent.historicalRuns.map((historicalRun) => ({
        id: historicalRun.id,
        text: historicalRun.text || historicalRun.metadata.subject_anchor,
        date: historicalRun.provenance.written_at,
        platform: inferPlatform([historicalRun.provenance.platform]),
        reason: historicalRun.metadata.category ?? undefined,
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
        memories,
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
        memories: conversations.map((conversation) => ({
          id: conversation.id,
          text: conversation.snippet,
          date: conversation.date,
          platform: conversation.platform,
        })),
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

function isExplicitLennyNewsletterLoop(loop: LoopWorkflow): boolean {
  return loop.definition?.presetId === "newsletter" && isLennyNewsletterGoal(loop.definition?.goal);
}

function isAnyLennyNewsletterLoop(loop: LoopWorkflow): boolean {
  return isLennyNewsletterGoal(loop.definition?.goal) || /lenny/i.test(loop.title);
}

function isWorkflowId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function cronToFrequency(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "Scheduled";
  const [, , dayOfMonth, , dayOfWeek] = parts;
  if (dayOfMonth === "*" && dayOfWeek === "*") return "Daily";
  if (dayOfMonth !== "*") return "Monthly";
  if (dayOfWeek !== "*") return "Weekly";
  return "Scheduled";
}

function buildLoopInsightFromWorkflow(workflow: LoopWorkflow): LoopInsight {
  const cron = workflow.definition?.schedule?.cron ?? workflow.scheduleRrule ?? "0 9 * * 1";
  const children = workflow.definition?.agentGraph?.children ?? [];
  const createdAt = workflow.createdAt ?? new Date().toISOString();
  const nextPredicted = workflow.nextRunAt ?? createdAt;

  const conversations: Conversation[] = children.length > 0
    ? children.map((child) => ({
        id: `${workflow.id}-${child.id}`,
        title: child.name,
        date: createdAt,
        platform: "chatgpt",
        snippet: child.task,
      }))
    : [{
        id: `${workflow.id}-goal`,
        title: workflow.definition?.agentGraph?.parent?.name ?? "Parent Agent",
        date: createdAt,
        platform: "chatgpt",
        snippet: workflow.definition?.goal ?? workflow.title,
      }];

  return {
    id: workflow.id,
    name: workflow.title,
    description: workflow.definition?.goal ?? workflow.title,
    workspaceId: workflow.workspaceId,
    primarySourceFile: workflow.definition?.builderMeta?.designedBy === "ceo_llm" ? "loop builder" : "loop creator",
    frequency: cronToFrequency(cron),
    conversationCount: conversations.length,
    lastOccurred: workflow.lastScheduledAt ?? createdAt,
    nextPredicted,
    confidence: 98,
    status: "detected",
    conversations,
    memories: conversations.slice(0, 3).map((conversation) => ({
      id: conversation.id,
      text: conversation.snippet,
      date: conversation.date,
      platform: conversation.platform,
      reason: `${conversation.title} agent`,
    })),
    isSaved: true,
  };
}

function findLennyNewsletterWorkflow(loops: LoopWorkflow[]): LoopWorkflow | null {
  return loops.find(isExplicitLennyNewsletterLoop)
    ?? loops.find(isAnyLennyNewsletterLoop)
    ?? loops.find((loop) =>
      isNewsletterLoopDefinition({
        goal: loop.definition?.goal,
        presetId: loop.definition?.presetId,
        title: loop.title,
      })
      && !/\bxyz\b/i.test(`${loop.title} ${loop.definition?.goal ?? ""}`)
    )
    ?? null;
}

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
    name: "Lenny's Weekly Newsletter",
    description: "Search Agent, Web Search Agent, Research Agent, Writer, and Publicist. Approval before Resend broadcast.",
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
        title: "Search Agent",
        date: previous.toISOString(),
        platform: "chatgpt",
        snippet: "Finds timely themes and surfaces high-signal internal source material.",
      },
      {
        id: "hardcoded-newsletter-writer",
        title: "Writer",
        date: last.toISOString(),
        platform: "chatgpt",
        snippet: "Writes the subscriber-facing newsletter draft from research outputs.",
      },
      {
        id: "hardcoded-newsletter-publicist",
        title: "Approval Handoff",
        date: now.toISOString(),
        platform: "claude",
        snippet: "Prepares the send or publish plan as an approval draft. No external action is committed.",
      },
    ],
    memories: [
      {
        id: "hardcoded-newsletter-memory-product",
        text: "Lenny writes a weekly product newsletter for product builders.",
        date: previous.toISOString(),
        platform: "chatgpt",
        reason: "This identifies the recurring weekly newsletter task.",
      },
      {
        id: "hardcoded-newsletter-memory-loop",
        text: "Automate Search, Research, Writer, and Publicist with Resend delivery after approval.",
        date: last.toISOString(),
        platform: "chatgpt",
        reason: "This confirms the recurring workflow should be automated.",
      },
      {
        id: "hardcoded-newsletter-memory-approval",
        text: "Publicist only prepares an approval draft. No external action is committed.",
        date: now.toISOString(),
        platform: "claude",
        reason: "This sets the publishing boundary for the loop.",
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
//  Memory Deck — always fanned
/* ------------------------------------------------------------------ */

function MemoryDeck({ memories }: { memories: LoopMemory[] }) {
  const total = memories.length;
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
      {memories.map((memory, index) => {
        const offset = index - (total - 1) / 2;
        const restRotation =
          (seededRandom(memory.id + "-rot") > 0.5 ? 1 : -1) * (Math.abs(offset) * 0.6 + 0.3);
        const fanRotation = offset * 7;
        const restX = offset * 34;
        const fanX = offset * 58;
        const restY = -index * 3;
        const fanY = Math.abs(offset) * 4;
        const ps = platformStyle(memory.platform);
        const isCardHovered = hoveredCardId === memory.id;

        return (
          <TooltipProvider key={memory.id} delayDuration={200}>
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
                  onMouseEnter={() => setHoveredCardId(memory.id)}
                  onMouseLeave={() =>
                    setHoveredCardId((current) => (current === memory.id ? null : current))
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
                        {formatDate(memory.date)}
                      </span>
                    </div>
                    <p className="line-clamp-3 text-xs font-medium leading-5 text-[var(--text)]">
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
  onDelete,
  running,
  deleting,
  actionLabel = "Open loop",
}: {
  loop: LoopInsight;
  index: number;
  onDismiss: (id: string) => void;
  onLoop: (id: string) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  running?: boolean;
  deleting?: boolean;
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
      <Card className="group relative overflow-hidden transition-shadow hover:shadow-md">
        {/* Slate-tinted header band */}
        <div className="flex items-center justify-between bg-slate-50 px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
              <RotateCcw size={11} className="text-slate-500" />
              {loop.frequency}
            </div>
            {loop.isSaved ? (
              <div className="flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                <Bot size={10} />
                Your loop
              </div>
            ) : null}
            {days <= 3 && days > 0 && (
              <div className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
                <Clock size={10} />
                Soon
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {loop.isSaved && onDelete ? (
              <button
                type="button"
                onClick={() => void onDelete(loop.id)}
                disabled={deleting || running}
                className="grid h-7 w-7 place-items-center rounded-md text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:opacity-50"
                aria-label="Delete loop"
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              </button>
            ) : null}
            <button
              onClick={() => onDismiss(loop.id)}
              className="grid h-7 w-7 place-items-center rounded-md text-slate-400 opacity-0 transition hover:bg-white hover:text-slate-700 hover:shadow-sm group-hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="px-5 pb-5 pt-3">
          {/* Title + meta */}
          <div className="mb-1">
            <h3 className="text-base font-bold text-[var(--text)]">{loop.name}</h3>
          </div>

          <div className="mb-1 mt-4">
            <MemoryDeck memories={memories} />
          </div>

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

            {!looped || loop.isSaved ? (
              <Button
                onClick={async () => {
                  try {
                    await onLoop(loop.id);
                    if (!loop.isSaved) setLooped(true);
                  } catch {
                    setLooped(false);
                  }
                }}
                disabled={running}
                className="h-8 gap-2 rounded-none px-4 text-sm text-white"
                style={{ backgroundColor: ACCENT }}
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
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
  const [workspaces, setWorkspaces] = useState<LoopWorkspace[]>([]);
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<"all" | "unassigned" | string>("all");
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loopActionError, setLoopActionError] = useState<string | null>(null);
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
  const [deletingLoopId, setDeletingLoopId] = useState<string | null>(null);
  const loadLoopMinerRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [response, workspacesResponse, loopsResponse, channelsResponse] = await Promise.all([
        fetch("/api/memories/cleanup/loop-miner/runs", { cache: "no-store" }),
        fetch("/api/workflows/workspaces", { cache: "no-store" }),
        fetch("/api/workflows/internal/loops", { cache: "no-store" }),
        fetch("/api/channels", { cache: "no-store" }),
      ]);
      const payload = (await response.json().catch(() => ({}))) as LoopMinerRunsPayload;
      const workspacesPayload = await workspacesResponse.json().catch(() => ({}));
      const loopsPayload = await loopsResponse.json().catch(() => ({}));
      const channelsPayload = await channelsResponse.json().catch(() => ({}));
      if (!response.ok && !loopsResponse.ok) {
        throw new Error(payload.error ?? "Failed to load loops");
      }
      if (!response.ok) {
        setError(payload.error ?? "Could not load detected patterns");
      }
      if (workspacesResponse.ok) {
        setWorkspaces(Array.isArray(workspacesPayload.workspaces) ? workspacesPayload.workspaces as LoopWorkspace[] : []);
      }
      if (channelsResponse.ok) {
        const channels = Array.isArray(channelsPayload.channels) ? channelsPayload.channels as ActiveChannel[] : [];
        const primaryChannel = channels.find((channel) => channel.enabled && channel.isPrimary)
          ?? channels.find((channel) => channel.enabled && (channel.kind === "gmail" || channel.kind === "email"));
        setActiveChannel(primaryChannel ?? null);
      }
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const internalLoops = loopsResponse.ok && Array.isArray(loopsPayload.loops) ? loopsPayload.loops as LoopWorkflow[] : [];
      const savedLoops = internalLoops.map(buildLoopInsightFromWorkflow);
      const newsletterWorkflow = findLennyNewsletterWorkflow(internalLoops);
      const displayRun = pickRunForDisplay(runs);
      const minedLoops = displayRun ? buildLoopInsightsFromRun(displayRun) : [];
      const hardcoded = { ...hardcodedNewsletterLoop(), workspaceId: newsletterWorkflow?.workspaceId ?? null };
      const savedIds = new Set(savedLoops.map((loop) => loop.id));
      setLoops([
        ...savedLoops,
        ...(newsletterWorkflow ? [] : [hardcoded]),
        ...minedLoops.filter((loop) => loop.id !== hardcoded.id && !savedIds.has(loop.id)),
      ]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop miner runs");
      setLoops([hardcodedNewsletterLoop()]);
      setActiveChannel(null);
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

  const openLoop = useCallback(async (id: string) => {
    setLoopActionError(null);
    setRunningLoopId(id);
    try {
      if (id === "hardcoded-newsletter-loop-v1") {
        router.push("/dashboard/loops/newsletter");
        return;
      }
      if (isWorkflowId(id)) {
        router.push(`/dashboard/loops/${id}`);
        return;
      }
      setLoops((prev) =>
        prev.map((l) => (l.id === id ? { ...l, status: "looped" as const } : l))
      );
    } catch (activateError) {
      setLoopActionError(activateError instanceof Error ? activateError.message : "Failed to open loop");
      throw activateError;
    } finally {
      setRunningLoopId(null);
    }
  }, [router]);

  const deleteLoop = useCallback(async (id: string) => {
    if (!isWorkflowId(id)) return;
    if (!confirm("Delete this loop? This cannot be undone.")) return;
    setLoopActionError(null);
    setDeletingLoopId(id);
    try {
      const response = await fetch(`/api/workflows/internal/loops/${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? "Failed to delete loop");
      }
      setLoops((prev) => prev.filter((loop) => loop.id !== id));
    } catch (deleteError) {
      setLoopActionError(deleteError instanceof Error ? deleteError.message : "Failed to delete loop");
      throw deleteError;
    } finally {
      setDeletingLoopId(null);
    }
  }, []);

  const filtered = useMemo(() => {
    const byConfidence = filter === "high"
      ? loops.filter((l) => l.confidence >= 80)
      : filter === "medium"
        ? loops.filter((l) => l.confidence >= 60 && l.confidence < 80)
        : loops;
    if (workspaceFilter === "all") return byConfidence;
    if (workspaceFilter === "unassigned") return byConfidence.filter((loop) => !loop.workspaceId);
    return byConfidence.filter((loop) => loop.workspaceId === workspaceFilter);
  }, [loops, filter, workspaceFilter]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-[calc(100vh-72px)] flex-col">
        {/* Header */}
        <header className="flex mx-auto max-w-5xl w-full flex-wrap items-end justify-between gap-4 border-b py-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">Loops</h1>
            <p className="mt-0.5 text-sm text-[var(--text-2)]">
              Your saved loops and patterns Tallei noticed in your work
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
            <Button
              type="button"
              className="h-9 gap-1.5 rounded-none bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => router.push("/dashboard/loops/new")}
            >
              <Bot size={14} />
              Build loop
              <ArrowRight size={14} />
            </Button>
            <Button type="button" variant="outline" className="h-9 gap-1.5" onClick={loadLoopMinerRuns} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
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
          <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-2">
            {[
              { id: "all", name: "All workspaces" },
              { id: "unassigned", name: "Unassigned" },
              ...workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
            ].map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => setWorkspaceFilter(workspace.id)}
                className={`border px-3 py-1.5 text-xs font-medium transition ${
                  workspaceFilter === workspace.id
                    ? "border-[var(--text)] bg-[var(--surface)] text-[var(--text)]"
                    : "border-[var(--border-light)] bg-white text-[var(--text-2)] hover:text-[var(--text)]"
                }`}
              >
                {workspace.name}
              </button>
            ))}
            <div
              className={`ml-auto inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-medium shadow-sm ${
                activeChannel
                  ? activeChannel.kind === "telegram"
                    ? "border-sky-200 bg-sky-50 text-sky-700"
                    : "border-indigo-200 bg-indigo-50 text-indigo-700"
                  : "border-[var(--border-light)] bg-white text-[var(--text-2)]"
              }`}
            >
              <span
                className={`grid h-6 w-6 place-items-center rounded-full border ${
                  activeChannel
                    ? activeChannel.kind === "telegram"
                      ? "border-sky-200 bg-white text-sky-500"
                      : "border-indigo-200 bg-white text-indigo-600"
                    : "border-slate-200 bg-slate-50 text-slate-400"
                }`}
              >
                {activeChannel ? (
                  activeChannel.kind === "telegram" ? (
                    <FaTelegramPlane size={12} />
                  ) : (
                    <MdMarkEmailRead size={13} />
                  )
                ) : (
                  <span className="h-2 w-2 rounded-full bg-slate-300" />
                )}
              </span>
              <span>Active channel</span>
              <span className="max-w-[12rem] truncate text-[var(--text)]">
                {activeChannel
                  ? `${activeChannel.kind === "telegram" ? "Telegram" : "Inbox"}`
                  : "None"}
              </span>
            </div>
          </div>
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
                      onLoop={openLoop}
                      onDelete={loop.isSaved ? deleteLoop : undefined}
                      running={runningLoopId === loop.id}
                      deleting={deletingLoopId === loop.id}
                      actionLabel="Open loop"
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

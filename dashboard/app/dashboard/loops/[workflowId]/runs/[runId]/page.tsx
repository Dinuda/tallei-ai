"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Info,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { AgentRow, AgentPlaceholder, CeoRow, type AgentRowTask } from "./components/agent-rows";
import { ChatDrawer, type ChatComment } from "./components/chat-drawer";
import {
  StrategyRosterEditor,
  type CatalogTool,
  type RosterAgent,
  type ValidationIssue,
} from "./components/strategy-roster-editor";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type LoopWorkflow = {
  id: string;
  title: string;
  status: string;
  nextRunAt: string | null;
  definition?: {
    goal: string;
    schedule?: { timezone?: string };
    ceo: { name: string; task: string; policy: string };
  };
};

type LoopRun = {
  id: string;
  workflowId: string;
  status: string;
  runMode: string;
  scheduledFor: string | null;
  strategyOutput: string | null;
  waitingForStrategyApproval: boolean;
  draftOutput: string | null;
  createdAt: string;
  updatedAt: string;
};

type LoopRunTask = {
  id: string;
  seq: number;
  agentId: string;
  agentName: string;
  toolKey: string;
  assignedTools?: Array<{ ref: string }>;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  errorJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
  latestComment: { id: string; author: string; body: string; createdAt: string } | null;
};

type WorkflowListRun = {
  id: string;
  status: string;
  draftOutput: string | null;
  createdAt: string;
};

type WorkflowListItem = {
  id: string;
  latestRun: WorkflowListRun | null;
};

type MemoryEntry = {
  label: string;
  source: "memory" | "context" | "credential";
};

type RunAction = "approve-strategy" | "approve" | "skip";

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting_for_strategy_approval",
  "strategy_approved",
  "waiting_for_approval",
]);

function readRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function formatDayDate(v: string | null) {
  if (!v) return "Not scheduled";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(v: string | null) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function prettyStatus(s: string) {
  return s.replace(/_/g, " ");
}

function stripMarkdown(v: string) {
  return v
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(v: string | null | undefined, fallback: string) {
  if (!v?.trim()) return fallback;
  const c = stripMarkdown(v);
  const s = c.match(/^(.{60,160}?)(?:\.|\n|$)/)?.[1] ?? c.slice(0, 130);
  return s.trim() ? `${s.trim()}${s.endsWith(".") ? "" : "…"}` : fallback;
}

function statusBadgeClass(s: string) {
  if (s === "completed" || s === "done") return "bg-sky-100 text-sky-800";
  if (s === "running" || s === "strategy_approved") return "bg-blue-100 text-blue-800";
  if (s.includes("waiting")) return "bg-amber-100 text-amber-800";
  if (s === "blocked" || s === "failed") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function getTaskOutput(task: {
  outputJson: unknown;
  latestComment?: { body: string } | null;
}): string {
  const out = readRecord(task.outputJson);
  const candidates = [out.text, out.message, out.summary, out.draft, task.latestComment?.body];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function looksTechnicalContent(v: string): boolean {
  const text = v.toLowerCase();
  return (
    text.includes("execution strategy") ||
    text.includes("approval constraints") ||
    text.includes("loop title") ||
    text.includes("loop goal") ||
    text.includes("topic researcher") ||
    text.includes("creative writer") ||
    text.includes("publicist (")
  );
}

function looksNewsletterContent(v: string): boolean {
  const text = v.toLowerCase();
  return (
    text.includes("subject:") ||
    text.includes("dear ") ||
    text.includes("hello ") ||
    text.includes("newsletter") ||
    text.includes("this week") ||
    text.includes("thanks for reading")
  );
}

function cleanNewsletterContent(v: string): string {
  const lines = v.split("\n");
  const blockedStarts = [
    "final output",
    "loop title",
    "loop goal",
    "execution strategy",
    "approval constraints",
    "this structured approach",
  ];
  const cutoffIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith("execution strategy"));
  const source = cutoffIndex >= 0 ? lines.slice(0, cutoffIndex) : lines;
  const cleaned = source.filter((line) => {
    const normalized = line.trim().toLowerCase();
    if (!normalized) return true;
    if (blockedStarts.some((start) => normalized.startsWith(start))) return false;
    if (/^\d+\.\s+(topic researcher|creative writer|publicist)/i.test(line.trim())) return false;
    if (/^[-*]\s+(output|approval status):/i.test(line.trim())) return false;
    return true;
  }).join("\n");
  return cleaned.trim();
}

function extractMemoryEntries(tasks: LoopRunTask[]): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const seen = new Set<string>();

  function push(label: string, source: MemoryEntry["source"]) {
    const clean = label.trim();
    if (!clean) return;
    const key = `${source}:${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: clean, source });
  }

  function scan(value: unknown, parentKey = "") {
    if (typeof value === "string") {
      if (parentKey.includes("memory") || parentKey.includes("context") || parentKey.includes("credential")) {
        push(value, parentKey.includes("credential") ? "credential" : parentKey.includes("memory") ? "memory" : "context");
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const row of value) scan(row, parentKey);
      return;
    }

    if (!value || typeof value !== "object") return;

    for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (key.includes("memory") || key.includes("context") || key.includes("credential")) {
        if (typeof rawVal === "string") {
          push(rawVal, key.includes("credential") ? "credential" : key.includes("memory") ? "memory" : "context");
        } else if (Array.isArray(rawVal)) {
          for (const row of rawVal) {
            if (typeof row === "string") {
              push(row, key.includes("credential") ? "credential" : key.includes("memory") ? "memory" : "context");
            } else {
              const record = readRecord(row);
              const name = [record.label, record.title, record.name, record.query, record.id].find((v) => typeof v === "string");
              if (typeof name === "string") {
                push(name, key.includes("credential") ? "credential" : key.includes("memory") ? "memory" : "context");
              }
            }
          }
        } else {
          const record = readRecord(rawVal);
          const name = [record.label, record.title, record.name, record.query, record.id].find((v) => typeof v === "string");
          if (typeof name === "string") {
            push(name, key.includes("credential") ? "credential" : key.includes("memory") ? "memory" : "context");
          }
        }
      }
      scan(rawVal, key);
    }
  }

  for (const task of tasks) scan(task.inputJson);
  return out.slice(0, 10);
}

function runAction(run: LoopRun | null): {
  show: boolean;
  headline: string;
  sub: string;
  cta: string;
  action: RunAction;
  tone: "amber" | "sky" | "rose";
} | null {
  const status = run?.status ?? "";
  if (status === "waiting_for_strategy_approval") {
    return {
      show: true,
      headline: "Ready to start this run",
      sub: "Start the run when you're ready.",
      cta: "Start run",
      action: "approve-strategy",
      tone: "amber",
    };
  }
  if (status === "waiting_for_approval") {
    return {
      show: true,
      headline: "Newsletter is ready for approval",
      sub: firstSentence(run?.draftOutput, "Review and approve this newsletter."),
      cta: "Approve newsletter",
      action: "approve",
      tone: "sky",
    };
  }
  if (status === "blocked") {
    return {
      show: true,
      headline: "Run needs a decision",
      sub: "Use steer or skip this run to continue.",
      cta: "Skip this run",
      action: "skip",
      tone: "rose",
    };
  }
  return null;
}

function RunBadge({ status }: { status: string }) {
  const isRunning = status === "running" || status === "strategy_approved";
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-0 capitalize shadow-none", statusBadgeClass(status))}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          status.includes("waiting") ? "bg-amber-500" :
          status === "completed" ? "bg-sky-500" :
          isRunning ? "bg-blue-500 animate-pulse" :
          "bg-muted-foreground/50"
        )}
      />
      {prettyStatus(status)}
    </Badge>
  );
}

export default function LoopRunDetailPage() {
  const params = useParams<{ workflowId: string; runId: string }>();
  const { workflowId, runId } = params;

  const [workflow, setWorkflow] = useState<LoopWorkflow | null>(null);
  const [run, setRun] = useState<LoopRun | null>(null);
  const [tasks, setTasks] = useState<LoopRunTask[]>([]);
  const [comments, setComments] = useState<ChatComment[]>([]);
  const [linkedLatestRun, setLinkedLatestRun] = useState<WorkflowListRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [toolCatalog, setToolCatalog] = useState<CatalogTool[]>([]);
  const [rosterIssues, setRosterIssues] = useState<ValidationIssue[]>([]);
  const [rosterEditable, setRosterEditable] = useState(false);
  const resumeAttemptedRef = useRef(false);

  const active = run ? ACTIVE_STATUSES.has(run.status) : false;
  const runStatus = run?.status ?? "loading";
  const wfStatus = workflow?.status ?? "active";
  const decision = runAction(run);

  const agentTasks = useMemo((): AgentRowTask[] => {
    return [...tasks]
      .sort((a, b) => a.seq - b.seq)
      .map((task) => ({
        id: task.id,
        agentName: task.agentName,
        toolKey: task.toolKey,
        agentId: task.agentId,
        status: task.status,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        inputJson: task.inputJson,
        outputJson: task.outputJson,
        latestComment: task.latestComment,
        assignedTools: task.assignedTools ?? [],
      }));
  }, [tasks]);

  const memoryEntries = useMemo(() => extractMemoryEntries(tasks), [tasks]);
  const activeAgentTask = expandedTaskId ? agentTasks.find((task) => task.id === expandedTaskId) ?? null : null;
  const writerTask = agentTasks.find((task) =>
    task.assignedTools?.some((tool) => tool.ref.includes("llm_only")) ||
    task.toolKey.includes("write") ||
    task.toolKey.includes("draft")
  ) ?? null;
  const rawPrimaryNewsletter = (() => {
    const runDraft = run?.draftOutput?.trim() ?? "";
    const writerOutput = writerTask ? getTaskOutput(writerTask) : "";
    if (runDraft && !looksTechnicalContent(runDraft)) return runDraft;
    if (writerOutput && (looksNewsletterContent(writerOutput) || looksTechnicalContent(runDraft))) return writerOutput;
    if (runDraft) return cleanNewsletterContent(runDraft);
    if (linkedLatestRun?.id && linkedLatestRun.id !== run?.id && linkedLatestRun.draftOutput?.trim()) {
      return cleanNewsletterContent(linkedLatestRun.draftOutput);
    }
    return "";
  })();
  const centerOutput = run?.status === "waiting_for_strategy_approval" && run.strategyOutput?.trim()
    ? run.strategyOutput
    : activeAgentTask
      ? getTaskOutput(activeAgentTask)
      : rawPrimaryNewsletter || null;
  const centerUpdatedAt = activeAgentTask ? activeAgentTask.completedAt ?? activeAgentTask.startedAt : run?.updatedAt ?? linkedLatestRun?.createdAt ?? null;

  useEffect(() => {
    if (!expandedTaskId) return;
    if (!agentTasks.some((task) => task.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
  }, [agentTasks, expandedTaskId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rRes, tRes, cRes, wRes, allRes, rosterRes] = await Promise.all([
        fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/tasks`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/comments`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
        fetch("/api/workflows", { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/roster`, { cache: "no-store" }),
      ]);
      const [rP, tP, cP, wP, allP, rosterP] = await Promise.all([
        rRes.json().catch(() => ({})),
        tRes.json().catch(() => ({})),
        cRes.json().catch(() => ({})),
        wRes.json().catch(() => ({})),
        allRes.json().catch(() => ({})),
        rosterRes.json().catch(() => ({})),
      ]);

      if (!rRes.ok) throw new Error((rP as { error?: string }).error ?? "Failed to load run");
      if (!tRes.ok) throw new Error((tP as { error?: string }).error ?? "Failed to load tasks");
      if (!cRes.ok) throw new Error((cP as { error?: string }).error ?? "Failed to load comments");

      if (wRes.ok) setWorkflow((wP as { loop: LoopWorkflow }).loop);
      setRun((rP as { run: LoopRun }).run);
      setTasks(Array.isArray((tP as { tasks?: LoopRunTask[] }).tasks) ? (tP as { tasks: LoopRunTask[] }).tasks : []);
      setComments(
        Array.isArray((cP as { comments?: ChatComment[] }).comments)
          ? (cP as { comments: ChatComment[] }).comments
          : []
      );

      if (rosterRes.ok) {
        const payload = rosterP as {
          roster?: {
            proposedRoster?: RosterAgent[];
            approvedRoster?: RosterAgent[] | null;
            editable?: boolean;
            toolCatalog?: CatalogTool[];
            validationIssues?: ValidationIssue[];
          };
        };
        const active = payload.roster?.approvedRoster?.length
          ? payload.roster.approvedRoster
          : payload.roster?.proposedRoster ?? [];
        setRoster(active);
        setToolCatalog(Array.isArray(payload.roster?.toolCatalog) ? payload.roster.toolCatalog : []);
        setRosterIssues(Array.isArray(payload.roster?.validationIssues) ? payload.roster.validationIssues : []);
        setRosterEditable(Boolean(payload.roster?.editable));
      }

      if (allRes.ok) {
        const workflows = Array.isArray((allP as { workflows?: WorkflowListItem[] }).workflows)
          ? (allP as { workflows: WorkflowListItem[] }).workflows
          : [];
        const linked = workflows.find((row) => row.id === workflowId);
        setLinkedLatestRun(linked?.latestRun ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [runId, workflowId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (resumeAttemptedRef.current || loading) return;
    if (!run || tasks.length === 0) return;
    if (run.status !== "strategy_approved" && run.status !== "running") return;

    const hasTodo = tasks.some((task) => task.status === "todo");
    const hasActive = tasks.some((task) => task.status === "in_progress" || task.status === "working");
    if (!hasTodo || hasActive) return;

    resumeAttemptedRef.current = true;
    void fetch(`/api/workflows/runs/${runId}/resume`, { method: "POST" })
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((payload as { error?: string }).error ?? "Failed to resume agents");
        }
        await load();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to resume agents");
      });
  }, [loading, run, tasks, runId, load]);

  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [active, load]);

  async function sendSteerComment(body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    const res = await fetch(`/api/workflows/runs/${runId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: trimmed }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to send steer message");
    setChatMessage("");
    await load();
  }

  async function saveRoster(next: RosterAgent[]) {
    setBusy("save-roster");
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/roster`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roster: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to save roster");
      setRoster(next);
      setRosterIssues(Array.isArray((payload as { validationIssues?: ValidationIssue[] }).validationIssues)
        ? (payload as { validationIssues: ValidationIssue[] }).validationIssues
        : []);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save roster");
    } finally {
      setBusy(null);
    }
  }

  async function doAction(action: RunAction) {
    setBusy(action);
    setError(null);
    try {
      const init: RequestInit = { method: "POST" };
      if (action === "approve-strategy" && roster.length > 0) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({ roster });
      }
      const res = await fetch(`/api/workflows/runs/${runId}/${action}`, init);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Action failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function togglePause() {
    if (!workflow) return;
    const act = wfStatus === "paused" ? "resume" : "pause";
    setBusy(act);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/${act}`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const toneCardClass = {
    amber: "bg-gradient-to-r from-amber-50 to-orange-50",
    sky: "bg-gradient-to-r from-sky-50 to-cyan-50",
    rose: "bg-gradient-to-r from-rose-50 to-red-50",
  };
  const toneBtnClass = {
    amber: "bg-amber-600 text-white shadow-sm hover:bg-amber-700",
    sky: "bg-sky-700 text-white shadow-sm hover:bg-sky-800",
    rose: "bg-rose-600 text-white shadow-sm hover:bg-rose-700",
  };

  const doneCount = agentTasks.filter((t) => t.status === "done" || t.status === "completed").length;
  const agentTotal = agentTasks.length > 0 ? agentTasks.length : roster.length;

  return (
    <TooltipProvider>
      <div className="relative flex h-[calc(100vh-56px)] flex-col overflow-hidden bg-slate-50/40">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0 space-y-0.5">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href="/dashboard/loops" className="text-xs">Loops</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href="/dashboard/loops/newsletter" className="text-xs">Newsletter</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-xs">Run {run?.id ? run.id.slice(0, 6) : "…"}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-slate-900">Newsletter</h1>
              <RunBadge status={runStatus} />
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Run info"
                      className="text-slate-500 hover:bg-white hover:text-slate-900"
                    >
                      <Info className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Run info</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>Run info</DropdownMenuLabel>
                {[
                  { label: "Next run", value: formatDayDate(workflow?.nextRunAt ?? null) },
                  { label: "Updated", value: formatRelative(run?.updatedAt ?? null) || "—" },
                  { label: "Mode", value: run?.runMode ?? "—" },
                ].map(({ label, value }) => (
                  <DropdownMenuItem key={label} disabled className="flex items-start justify-between gap-2">
                    <span className="text-xs text-slate-500">{label}</span>
                    <span className="text-right text-xs font-medium text-slate-900">{value}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void load()}
                  disabled={loading}
                  aria-label="Refresh"
                  className="text-slate-500 hover:bg-white hover:text-slate-900"
                >
                  <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void togglePause()}
              disabled={!workflow || busy === "pause" || busy === "resume"}
              aria-label={wfStatus === "paused" ? "Resume loop" : "Pause loop"}
              className="text-slate-500 hover:bg-white hover:text-slate-900"
            >
              {busy === "pause" || busy === "resume"
                ? <Loader2 className="size-4 animate-spin" />
                : wfStatus === "paused"
                  ? <Play className="size-4" />
                  : <Pause className="size-4" />}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="More options" className="text-slate-500 hover:bg-white">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Run</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => navigator.clipboard?.writeText(run?.id ?? "")}>
                  <Copy className="size-4" />
                  Copy run ID
                </DropdownMenuItem>
                <DropdownMenuItem disabled>
                  <Settings className="size-4" />
                  Mode: {run?.runMode ?? "—"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy !== null || runStatus === "completed"}
                  onClick={() => void doAction("skip")}
                >
                  <XCircle className="size-4" />
                  Skip run
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-4 pb-4 lg:px-5">
          <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden">
            {error ? (
              <Alert variant="destructive" className="flex-none shadow-sm">
                <AlertCircle className="size-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {decision ? (
              <Card className={cn("shrink-0 gap-0 py-0 ring-0 shadow-md", toneCardClass[decision.tone])}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/80 shadow-sm">
                      <ShieldCheck className="size-5 text-slate-700" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{decision.headline}</p>
                      <p className="mt-0.5 text-sm text-slate-600">{decision.sub}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className={toneBtnClass[decision.tone]}
                      disabled={busy !== null}
                      onClick={() => void doAction(decision.action)}
                    >
                      {busy === decision.action ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      {decision.cta}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-slate-700 hover:bg-white/60"
                      onClick={() => setChatOpen(true)}
                    >
                      Request changes
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {run?.status === "waiting_for_strategy_approval" && roster.length > 0 ? (
              <StrategyRosterEditor
                roster={roster}
                toolCatalog={toolCatalog}
                validationIssues={rosterIssues}
                editable={rosterEditable}
                busy={busy !== null}
                onChange={setRoster}
                onSave={saveRoster}
              />
            ) : null}

            <Card className="min-h-0 flex-1 gap-0 overflow-hidden py-0 ring-0 shadow-md">
              <CardHeader className="space-y-2 border-0 bg-gradient-to-r from-orange-50/70 via-white to-sky-50/70 px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                      Newsletter
                    </span>
                    <CardDescription className="text-slate-600">
                      {run?.status === "waiting_for_strategy_approval"
                        ? "CEO strategy proposal"
                        : activeAgentTask
                          ? `${activeAgentTask.agentName} output`
                          : "Written content"}
                    </CardDescription>
                  </div>
                  {activeAgentTask ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 border-slate-300 text-slate-700 hover:bg-slate-100"
                      onClick={() => setExpandedTaskId(null)}
                    >
                      Show newsletter
                    </Button>
                  ) : null}
                </div>
              </CardHeader>

              <CardContent className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-2">
                {centerOutput?.trim() ? (
                  <article className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                    {centerUpdatedAt ? (
                      <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                        Updated {formatRelative(centerUpdatedAt)}
                      </p>
                    ) : null}
                    <div className="text-sm leading-7 text-slate-800 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:mb-3.5 [&_strong]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc">
                      <Streamdown>{centerOutput}</Streamdown>
                    </div>
                  </article>
                ) : (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    {loading ? (
                      <>
                        <Loader2 className="size-7 animate-spin text-slate-500" />
                        <p className="mt-3 text-sm text-slate-500">Loading…</p>
                      </>
                    ) : (
                      <>
                        <div className="grid size-14 place-items-center rounded-2xl bg-slate-100">
                          <FileText className="size-6 text-slate-500" />
                        </div>
                        <p className="mt-4 text-sm font-medium text-slate-800">No newsletter content available yet.</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {active ? "Open an agent row to inspect its output while the run progresses." : "Start a new run to generate output."}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </main>

          <aside className="hidden w-[320px] shrink-0 flex-col gap-3 overflow-hidden lg:flex">
            <ScrollArea className="flex-1 pr-1">
              <div className="space-y-3">
                <Card className="gap-3 py-4 ring-0 shadow-md">
                  <CardHeader className="px-4 pb-0">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm text-slate-900">Agents</CardTitle>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                        {doneCount}/{agentTotal} done
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 px-3">
                    <CeoRow
                      name={workflow?.definition?.ceo?.name ?? "CEO"}
                      statusLabel={prettyStatus(runStatus)}
                      runStatus={runStatus}
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedTaskId(null)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm transition-colors",
                        expandedTaskId === null
                          ? "border-slate-900 text-slate-900"
                          : "border-slate-200 text-slate-700 hover:border-slate-300"
                      )}
                    >
                      <span className="grid size-8 place-items-center rounded-lg bg-slate-100">
                        <FileText className="size-3.5" />
                      </span>
                      <span className="text-sm font-semibold">Newsletter</span>
                    </button>
                    {loading && agentTasks.length === 0 && roster.length === 0 ? (
                      <AgentPlaceholder />
                    ) : agentTasks.length > 0 ? (
                      agentTasks.map((task) => (
                        <AgentRow
                          key={task.id}
                          task={task}
                          open={expandedTaskId === task.id}
                          onToggle={() => {
                            setExpandedTaskId((current) => current === task.id ? null : task.id);
                          }}
                        />
                      ))
                    ) : roster.length > 0 && run?.status === "waiting_for_strategy_approval" ? (
                      roster.map((agent, index) => (
                        <div key={`${agent.id}-${index}`} className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-2.5 text-left shadow-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-slate-900">{agent.name}</span>
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                              Pending
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-slate-500">{agent.task}</p>
                          {agent.tools.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {agent.tools.map((tool) => (
                                <span key={tool.ref} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                                  {tool.ref.replace(/^[^.]+\./, "")}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <p className="py-4 text-center text-xs text-slate-500">
                        Agent updates appear after the run starts.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="gap-3 py-4 ring-0 shadow-md">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm text-slate-900">From memory</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 px-4">
                    {memoryEntries.length > 0 ? (
                      memoryEntries.map((entry) => (
                        <div key={`${entry.source}-${entry.label}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <span className="text-xs text-slate-700">{entry.label}</span>
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            entry.source === "credential"
                              ? "bg-rose-100 text-rose-700"
                              : entry.source === "memory"
                                ? "bg-sky-100 text-sky-700"
                                : "bg-amber-100 text-amber-800"
                          )}>
                            {entry.source}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-slate-500">No memory records were attached to this run yet.</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </ScrollArea>
          </aside>
        </div>

        <div className="flex shrink-0 items-center justify-between bg-white/90 px-4 py-3 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] backdrop-blur lg:hidden">
          <span className="text-xs font-medium text-slate-600">
            {doneCount}/{agentTasks.length} agents done
          </span>
          <Button
            type="button"
            size="sm"
            className="gap-1.5 bg-slate-900 text-white hover:bg-slate-800"
            onClick={() => setChatOpen(true)}
          >
            <MessageSquare className="size-4" />
            Steer
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center gap-2 border border-r-0 border-slate-300 bg-slate-100 px-2.5 py-4 text-slate-900 shadow-lg lg:flex"
        >
          <MessageSquare className="size-4 rotate-90" />
          <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-[0.08em]">Steer</span>
        </button>

        <ChatDrawer
          open={chatOpen}
          onOpenChange={setChatOpen}
          comments={comments}
          message={chatMessage}
          setMessage={setChatMessage}
          onSend={sendSteerComment}
        />

        {loading ? (
          <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-white/60 backdrop-blur-[2px]">
            <div className="flex items-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm shadow-lg ring-1 ring-slate-200/50">
              <Loader2 className="size-4 animate-spin text-slate-600" />
              <span className="text-slate-700">Loading run…</span>
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

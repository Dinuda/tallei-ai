"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Crown,
  FileText,
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

import { AgentRow, AgentPlaceholder, type AgentRowTask } from "./components/agent-rows";
import { ChatDrawer, type ChatComment } from "./components/chat-drawer";

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

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
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  errorJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
  latestComment: { id: string; author: string; body: string; createdAt: string } | null;
};

type RunAction = "approve-strategy" | "approve" | "skip";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting_for_strategy_approval",
  "strategy_approved",
  "waiting_for_approval",
]);

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
  if (s === "completed" || s === "done") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (s === "running" || s === "strategy_approved") return "border-blue-200 bg-blue-50 text-blue-800";
  if (s.includes("waiting")) return "border-amber-200 bg-amber-50 text-amber-800";
  if (s === "blocked" || s === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/50 text-muted-foreground";
}

// What content to show as the hero artifact
function heroContent(run: LoopRun | null) {
  const status = run?.status ?? "";
  const hasDraft = Boolean(run?.draftOutput?.trim());
  const hasStrategy = Boolean(run?.strategyOutput?.trim());

  if (hasDraft || status === "waiting_for_approval" || status === "completed") {
    return {
      label: "DRAFT",
      description: status === "waiting_for_approval"
        ? "Ready for your approval — review before anything goes out."
        : "Final output from this run.",
      content: run?.draftOutput ?? null,
      empty: "The draft isn't ready yet.",
    };
  }
  if (hasStrategy || status === "waiting_for_strategy_approval") {
    return {
      label: "STRATEGY",
      description: "The CEO's execution plan — approve to start agents.",
      content: run?.strategyOutput ?? null,
      empty: "The CEO is still mapping out the strategy.",
    };
  }
  return {
    label: "OUTPUT",
    description: "Live preview of this run's most recent artifact.",
    content: null,
    empty: "Nothing here yet — agents are getting started.",
  };
}

// Single decisive action for the run
function runAction(run: LoopRun | null): {
  show: boolean;
  headline: string;
  sub: string;
  cta: string;
  action: RunAction;
  tone: "amber" | "emerald" | "rose";
} | null {
  const s = run?.status ?? "";
  if (s === "waiting_for_strategy_approval") {
    return {
      show: true,
      headline: "Approve strategy to start agents",
      sub: firstSentence(run?.strategyOutput, "The CEO has mapped out the execution plan."),
      cta: "Approve strategy",
      action: "approve-strategy",
      tone: "amber",
    };
  }
  if (s === "waiting_for_approval") {
    return {
      show: true,
      headline: "Approve draft before anything is sent",
      sub: firstSentence(run?.draftOutput, "The newsletter draft is ready for your review."),
      cta: "Approve draft",
      action: "approve",
      tone: "emerald",
    };
  }
  if (s === "blocked") {
    return {
      show: true,
      headline: "Run is blocked — skip or steer to continue",
      sub: "Something needs a human decision before agents can proceed.",
      cta: "Skip this run",
      action: "skip",
      tone: "rose",
    };
  }
  return null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RunBadge({ status }: { status: string }) {
  const isRunning = status === "running" || status === "strategy_approved";
  return (
    <Badge variant="outline" className={cn("gap-1.5 capitalize", statusBadgeClass(status))}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          status.includes("waiting") ? "bg-amber-500" :
          status === "completed" ? "bg-emerald-500" :
          isRunning ? "bg-blue-500 animate-pulse" :
          "bg-muted-foreground/50"
        )}
      />
      {prettyStatus(status)}
    </Badge>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoopRunDetailPage() {
  const params = useParams<{ workflowId: string; runId: string }>();
  const { workflowId, runId } = params;

  const [workflow, setWorkflow] = useState<LoopWorkflow | null>(null);
  const [run, setRun] = useState<LoopRun | null>(null);
  const [tasks, setTasks] = useState<LoopRunTask[]>([]);
  const [comments, setComments] = useState<ChatComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState("");

  const active = run ? ACTIVE_STATUSES.has(run.status) : false;
  const runStatus = run?.status ?? "loading";
  const wfStatus = workflow?.status ?? "active";
  const hero = heroContent(run);
  const decision = runAction(run);

  const agentTasks = useMemo((): AgentRowTask[] => {
    const research = tasks.find((t) => t.toolKey.includes("research"));
    const writer = tasks.find((t) => t.toolKey.includes("write") || t.toolKey.includes("draft"));
    const pub = tasks.find((t) => t.toolKey.includes("publication") || t.toolKey.includes("publish"));
    const ordered = [research, writer, pub].filter((t): t is LoopRunTask => Boolean(t));
    const rest = tasks.filter((t) => !ordered.some((o) => o.id === t.id));
    return [...ordered, ...rest];
  }, [tasks]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rRes, tRes, cRes, wRes] = await Promise.all([
        fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/tasks`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/comments`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
      ]);
      const [rP, tP, cP, wP] = await Promise.all([
        rRes.json().catch(() => ({})),
        tRes.json().catch(() => ({})),
        cRes.json().catch(() => ({})),
        wRes.json().catch(() => ({})),
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [runId, workflowId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [active, load]);

  async function doAction(action: RunAction) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/${action}`, { method: "POST" });
      const p = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(p.error ?? "Action failed");
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
      const p = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(p.error ?? "Failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const toneClass = {
    amber: "bg-amber-50 border-amber-100 text-amber-900",
    emerald: "bg-emerald-50 border-emerald-100 text-emerald-900",
    rose: "bg-rose-50 border-rose-100 text-rose-900",
  };
  const toneBtnClass = {
    amber: "bg-amber-900 text-amber-50 hover:bg-amber-800",
    emerald: "bg-emerald-700 text-white hover:bg-emerald-600",
    rose: "bg-rose-700 text-white hover:bg-rose-600",
  };

  return (
    <TooltipProvider>
      {/* Full-viewport app layout — no page scroll */}
      <div className="flex h-[calc(100vh-56px)] flex-col overflow-hidden bg-background">

        {/* ── Header ── */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-5 py-3">
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
                    <Link href="/dashboard/loops/newsletter" className="text-xs">{workflow?.title ?? "Loop"}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-xs">Run {run?.id ? run.id.slice(0, 6) : "…"}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">{workflow?.title ?? "Loop run"}</h1>
              <RunBadge status={runStatus} />
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setChatOpen(true)}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <MessageSquare className="size-4" />
              <span className="hidden sm:inline">Steer</span>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void load()}
                  disabled={loading}
                  aria-label="Refresh"
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
            >
              {busy === "pause" || busy === "resume"
                ? <Loader2 className="size-4 animate-spin" />
                : wfStatus === "paused"
                  ? <Play className="size-4" />
                  : <Pause className="size-4" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="More options">
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

        {/* ── Body: two columns ── */}
        <div className="flex min-h-0 flex-1 overflow-hidden">

          {/* ── Main: output / artifact ── */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">

            {/* Error */}
            {error ? (
              <Alert variant="destructive" className="m-4 flex-none">
                <AlertCircle className="size-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {/* Decision strip — thin, full width, only when action needed */}
            {decision ? (
              <div className={cn("flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3", toneClass[decision.tone])}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <ShieldCheck className="size-4 shrink-0 opacity-70" />
                  <div className="min-w-0">
                    <span className="text-sm font-semibold">{decision.headline}</span>
                    <span className="ml-2 hidden text-sm opacity-70 sm:inline">{decision.sub}</span>
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
                    className="opacity-70 hover:opacity-100"
                    onClick={() => setChatOpen(true)}
                  >
                    Request changes
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Artifact — this is what the user came to see */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Label row */}
              <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {hero.label}
                </span>
                <span className="text-xs text-muted-foreground">{hero.description}</span>
              </div>

              {/* Content */}
              {hero.content?.trim() ? (
                <div className="px-6 py-6 text-sm leading-7 text-foreground/90 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:font-semibold [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:mb-3.5 [&_strong]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc">
                  <Streamdown>{hero.content}</Streamdown>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  {loading ? (
                    <>
                      <Loader2 className="size-6 animate-spin text-muted-foreground/50" />
                      <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
                    </>
                  ) : (
                    <>
                      <div className="grid size-12 place-items-center rounded-full bg-muted/50">
                        <FileText className="size-5 text-muted-foreground/50" />
                      </div>
                      <p className="mt-4 text-sm font-medium text-muted-foreground">{hero.empty}</p>
                      <p className="mt-1 text-xs text-muted-foreground/60">
                        {active ? "This page updates automatically every few seconds." : "Start a new run to generate output."}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </main>

          {/* ── Sidebar: agents + meta ── */}
          <aside className="hidden w-72 shrink-0 flex-col overflow-hidden border-l lg:flex">
            <ScrollArea className="flex-1">
              <div className="space-y-0.5 px-2 pt-4">
                {/* CEO orchestrator */}
                <div className="mb-1 flex items-center gap-2 px-2.5 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Agents
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    {agentTasks.filter((t) => t.status === "done" || t.status === "completed").length}/{agentTasks.length} done
                  </span>
                </div>

                {/* CEO row */}
                <div className="flex items-start gap-2.5 rounded-md px-2.5 py-2">
                  <span
                    className={cn(
                      "mt-[5px] size-1.5 shrink-0 rounded-full",
                      runStatus === "completed" ? "bg-emerald-500" :
                      runStatus === "running" || runStatus === "strategy_approved" ? "bg-blue-500 animate-pulse" :
                      "bg-muted-foreground/30"
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium">
                        <Crown className="mb-0.5 mr-1 inline size-3 text-muted-foreground" />
                        {workflow?.definition?.ceo?.name ?? "CEO"}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground capitalize">
                        {prettyStatus(runStatus)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                      Orchestrates the run
                    </p>
                  </div>
                </div>

                <div className="mx-2.5 my-1">
                  <Separator />
                </div>

                {/* Agent tasks */}
                {loading && agentTasks.length === 0 ? (
                  <AgentPlaceholder />
                ) : agentTasks.length > 0 ? (
                  agentTasks.map((task) => (
                    <AgentRow key={task.id} task={task} />
                  ))
                ) : (
                  <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
                    Agents appear after strategy approval.
                  </p>
                )}
              </div>

              {/* Run meta */}
              <div className="mx-4 my-4">
                <Separator />
              </div>
              <div className="space-y-3 px-4 pb-6">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Run info
                </p>
                {[
                  { label: "Next run", value: formatDayDate(workflow?.nextRunAt ?? null) },
                  { label: "Updated", value: formatRelative(run?.updatedAt ?? null) || "—" },
                  { label: "Mode", value: run?.runMode ?? "—" },
                  { label: "Timezone", value: workflow?.definition?.schedule?.timezone ?? "Local" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-start justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span className="text-right text-xs font-medium text-foreground">{value}</span>
                  </div>
                ))}

                {workflow?.definition?.goal ? (
                  <>
                    <Separator />
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Goal</p>
                      <p className="text-xs leading-5 text-muted-foreground">{workflow.definition.goal}</p>
                    </div>
                  </>
                ) : null}
              </div>
            </ScrollArea>

            {/* Chat trigger at bottom of sidebar */}
            <div className="border-t p-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full gap-2 text-muted-foreground"
                onClick={() => setChatOpen(true)}
              >
                <MessageSquare className="size-4" />
                Chat with CEO
                <ChevronRight className="ml-auto size-3" />
              </Button>
            </div>
          </aside>
        </div>

        {/* ── Mobile: bottom chat trigger ── */}
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 lg:hidden">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{agentTasks.filter((t) => t.status === "done" || t.status === "completed").length}/{agentTasks.length} agents done</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChatOpen(true)}
            className="gap-1.5"
          >
            <MessageSquare className="size-4" />
            Steer
          </Button>
        </div>

        {/* ── Chat drawer (vaul, direction right) ── */}
        <ChatDrawer
          open={chatOpen}
          onOpenChange={setChatOpen}
          comments={comments}
          message={chatMessage}
          setMessage={setChatMessage}
        />
      </div>
    </TooltipProvider>
  );
}

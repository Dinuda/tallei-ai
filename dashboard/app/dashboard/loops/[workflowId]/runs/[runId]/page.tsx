"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  AlertCircle,
  BarChart3,
  Check,
  ChevronLeft,
  Code,
  Copy,
  Eye,
  FileText,
  Info,
  Loader2,
  Mail,
  Megaphone,
  MessageSquare,
  MoreHorizontal,
  MousePointerClick,
  Pause,
  Play,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Upload,
  Users,
  XCircle,
} from "lucide-react";

import { AgentRow, AgentPlaceholder, ApprovalGateRow, CeoRow, type AgentRowTask, type ApprovalGateInfo } from "./components/agent-rows";
import { ChatDrawer, type ChatComment } from "./components/chat-drawer";
import { EmailBuilderDialog } from "./components/email-builder-dialog";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    presetId?: string;
    allowedIntegrations?: string[];
    allowedToolRefs?: string[];
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
  activeGateId?: string | null;
  activeGateStageId?: string | null;
  pendingInput?: {
    id: string;
    kind: string;
    label: string;
    status: "pending" | "submitted";
    instructions: string | null;
  } | null;
  deliveryAction?: {
    kind: string;
    status: string;
    recipientCount: number;
    successCount: number;
    failureCount: number;
    startedAt?: string | null;
    completedAt?: string | null;
    broadcastId?: string | null;
  } | null;
  stats?: {
    contacts: {
      uploadedAt: string | null;
      recipientCount: number;
      documentRef?: string | null;
      lotRef?: string | null;
      contacts?: Array<{ email: string; name: string | null }>;
    } | null;
    delivery: {
      sentAt: string | null;
      successCount: number;
      failureCount: number;
      dryRun?: boolean;
      error?: string | null;
      openCount?: number;
      clickCount?: number;
      unsubscribeCount?: number;
      openRate?: number;
      clickRate?: number;
      deliveredCount?: number;
      totalClickCount?: number;
      bounceCount?: number;
      failedEventCount?: number;
      complaintCount?: number;
      metricsWebhook?: {
        id?: string | null;
        endpoint?: string | null;
        created?: boolean;
        updated?: boolean;
        events?: string[];
      };
      trackingDiagnostics?: {
        htmlBytes?: number;
        textBytes?: number;
        gmailClippingRisk?: boolean;
        gmailClippingWarningBytes?: number;
        openTracking?: string;
        note?: string;
        webhookEndpoint?: string | null;
      };
    } | null;
  };
  emailTemplate?: {
    html: string;
    design: unknown;
    updatedAt: string | null;
  } | null;
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

type LoopRunGate = {
  id: string;
  stageId: string;
  kind: string;
  status: string;
  title: string;
  artifactId: string | null;
  payload: unknown;
  createdAt: string;
  completedAt: string | null;
};

type MemoryEntry = {
  label: string;
  source: "memory" | "context" | "credential";
};

type RunAction = "approve-strategy" | "approve" | "approve-gate" | "skip" | "resume";

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting_for_strategy_approval",
  "strategy_approved",
  "waiting_for_email_approval",
  "waiting_for_approval",
  "waiting_for_gate",
]);

const CHANNEL_LABELS: Record<string, string> = {
  primary: "Primary channel",
  email: "Email",
  gmail: "Gmail",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

function pendingApprovalGate(gates: LoopRunGate[]): LoopRunGate | null {
  return gates.find((gate) => gate.kind === "approval" && gate.status === "pending") ?? null;
}

function gateApprovalChannels(gate: LoopRunGate | null): string[] {
  if (!gate?.payload || typeof gate.payload !== "object" || Array.isArray(gate.payload)) return ["primary"];
  const stage = (gate.payload as { stage?: { approvalPolicy?: { channels?: string[] } } }).stage;
  const channels = stage?.approvalPolicy?.channels;
  return Array.isArray(channels) && channels.length > 0 ? channels : ["primary"];
}

function isAwaitingApprovalStatus(status: string, gates: LoopRunGate[]): boolean {
  if (status === "waiting_for_approval" || status === "waiting_for_email_approval") {
    return true;
  }
  if (pendingApprovalGate(gates)) return true;
  return false;
}

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

function prettyStatus(s: string, gates: LoopRunGate[] = []) {
  if (pendingApprovalGate(gates)) return "awaiting approval";
  if (s === "waiting_for_email_approval" || s === "waiting_for_approval") return "awaiting approval";
  if (s === "waiting_for_contact_list") return "awaiting contacts";
  if (s === "waiting_for_input") return "awaiting input";
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

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${Math.round(value * 100)}%`;
}

function statusBadgeClass(s: string, gates: LoopRunGate[] = []) {
  if (s === "completed" || s === "done") return "bg-sky-100 text-sky-800";
  if (s === "running" || s === "strategy_approved") return "bg-blue-100 text-blue-800";
  if (s.includes("waiting") || isAwaitingApprovalStatus(s, gates)) return "bg-amber-100 text-amber-800";
  if (s === "blocked" || s === "failed") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function getTaskOutput(task: {
  status: string;
  outputJson: unknown;
  latestComment?: { body: string } | null;
}): string {
  const out = readRecord(task.outputJson);
  const candidates = [out.text, out.message, out.summary, out.draft, out.artifactBody];
  if (task.status !== "todo" || candidates.some((value) => typeof value === "string" && value.trim())) {
    candidates.push(task.latestComment?.body);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function isPublicistTask(task: AgentRowTask): boolean {
  const refs = (task.assignedTools ?? []).map((t) => t.ref).join(" ").toLowerCase();
  return (
    refs.includes("email_approval_request") ||
    task.agentId.toLowerCase().includes("approval") ||
    task.agentId.toLowerCase().includes("publicist") ||
    task.toolKey.toLowerCase().includes("email_approval")
  );
}

function isWriterTask(task: AgentRowTask): boolean {
  const key = `${task.agentId} ${task.agentName} ${task.toolKey}`.toLowerCase();
  return (
    key.includes("writer") ||
    key.includes("creative writer") ||
    (key.includes("write") && !key.includes("research") && !key.includes("search")) ||
    key.includes("draft")
  );
}

function isAgentRowOpen(task: AgentRowTask, expandedTaskId: string | null): boolean {
  if (isWriterTask(task)) return expandedTaskId === null;
  return expandedTaskId === task.id;
}

function getPublicistMeta(task: AgentRowTask) {
  const out = readRecord(task.outputJson);
  const req = readRecord(out.approvalRequest);
  return {
    to: typeof req.to === "string" ? req.to : null,
    channel: typeof req.channel === "string" ? req.channel : null,
    sentAt: typeof req.sentAt === "string" ? req.sentAt : null,
    artifactBody: typeof out.artifactBody === "string" ? out.artifactBody : null,
    emailApprovalSent: out.emailApprovalSent === true,
  };
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

function parseNewsletterSubjectAndGreeting(v: string): { subject: string; greeting: string } {
  const lines = v.split("\n");
  let subject = "";
  let greeting = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const subjectMatch = trimmed.match(/^Subject:\s*(.+)$/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      continue;
    }
    if (!greeting && /^\*.+\*$/.test(trimmed)) {
      greeting = trimmed.replace(/^\*|\*$/g, "").trim();
      continue;
    }
    if (subject && greeting) break;
  }

  return { subject, greeting };
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

function needsApprovalHandoffContinue(
  run: LoopRun | null,
  tasks: LoopRunTask[],
  gates: LoopRunGate[],
): boolean {
  if (!run || run.status !== "running") return false;
  if (pendingApprovalGate(gates)) return false;
  const handoffTodo = tasks.some(
    (t) => /approval_handoff|publicist/i.test(t.agentId) && t.status === "todo",
  );
  const writerDone = tasks.some(
    (t) => /writer/i.test(t.agentId) && (t.status === "done" || t.status === "completed"),
  );
  const hasActive = tasks.some((t) => t.status === "in_progress" || t.status === "working");
  return handoffTodo && writerDone && !hasActive;
}

function runAction(
  run: LoopRun | null,
  gates: LoopRunGate[],
  tasks: LoopRunTask[],
): {
  show: boolean;
  headline: string;
  sub: string;
  cta: string;
  action: RunAction;
  tone: "amber" | "sky" | "rose";
  channels?: string[];
} | null {
  const status = run?.status ?? "";
  const pendingGate = pendingApprovalGate(gates);
  const gateChannels = gateApprovalChannels(pendingGate);

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
  if (pendingGate) {
    const channelText = gateChannels.map((c) => CHANNEL_LABELS[c] ?? c).join(", ");
    return {
      show: true,
      headline: pendingGate.title,
      sub: `Approval required via ${channelText}. Review the draft, then approve to continue.`,
      cta: "Approve",
      action: "approve-gate",
      tone: "sky",
      channels: gateChannels,
    };
  }
  if (status === "waiting_for_approval" || status === "waiting_for_email_approval") {
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
  if (needsApprovalHandoffContinue(run, tasks, gates)) {
    return {
      show: true,
      headline: "Draft ready — continue to approval",
      sub: "The writer finished. Continue to send the draft for operator approval.",
      cta: "Continue",
      action: "resume",
      tone: "sky",
    };
  }
  return null;
}

function isNewsletterPresetWorkflow(workflow: LoopWorkflow | null): boolean {
  const definition = workflow?.definition;
  if (!definition) return false;
  return definition.presetId === "newsletter"
    || /\bnewsletter\b/i.test(definition.goal)
    || Boolean(definition.allowedToolRefs?.includes("internal.resend_broadcast"));
}

function RunBadge({ status, gates = [] }: { status: string; gates?: LoopRunGate[] }) {
  const isRunning = status === "running" || status === "strategy_approved";
  const awaiting = isAwaitingApprovalStatus(status, gates);
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-0 capitalize shadow-none", statusBadgeClass(status, gates))}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          awaiting ? "bg-amber-500" :
          status === "completed" ? "bg-sky-500" :
          isRunning ? "bg-blue-500 animate-pulse" :
          "bg-muted-foreground/50"
        )}
      />
      {prettyStatus(status, gates)}
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
  const [gates, setGates] = useState<LoopRunGate[]>([]);
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
  const [draftEditor, setDraftEditor] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [emailHtml, setEmailHtml] = useState("");
  const [emailDesign, setEmailDesign] = useState<unknown>(null);
  const [emailSource, setEmailSource] = useState<"auto" | "builder" | null>(null);
  const [emailPreviewBusy, setEmailPreviewBusy] = useState(false);
  const [emailBuilderOpen, setEmailBuilderOpen] = useState(false);
  const resumeAttemptedRef = useRef<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const active = run ? ACTIVE_STATUSES.has(run.status) : false;
  const runStatus = run?.status ?? "loading";
  const wfStatus = workflow?.status ?? "active";
  const decision = runAction(run, gates, tasks);
  const pendingGate = pendingApprovalGate(gates);
  const approvalGateInfo: ApprovalGateInfo | null = pendingGate
    ? {
        id: pendingGate.id,
        title: pendingGate.title,
        artifactId: pendingGate.artifactId,
        channels: gateApprovalChannels(pendingGate),
        status: pendingGate.status,
      }
    : null;
  const predefinedNewsletterRun = isNewsletterPresetWorkflow(workflow);
  const showCsvUpload = runStatus === "waiting_for_contact_list" || runStatus === "waiting_for_input";

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
  const writerTask = agentTasks.find(isWriterTask) ?? null;
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
  const centerOutput = run?.status === "waiting_for_strategy_approval" && !predefinedNewsletterRun && run.strategyOutput?.trim()
    ? run.strategyOutput
    : activeAgentTask
      ? getTaskOutput(activeAgentTask)
      : rawPrimaryNewsletter || null;
  const centerUpdatedAt = activeAgentTask ? activeAgentTask.completedAt ?? activeAgentTask.startedAt : run?.updatedAt ?? linkedLatestRun?.createdAt ?? null;
  const isPublicistView = Boolean(activeAgentTask && isPublicistTask(activeAgentTask));
  const publicistMeta = activeAgentTask && isPublicistTask(activeAgentTask) ? getPublicistMeta(activeAgentTask) : null;
  const isNewsletterArtifactView = !activeAgentTask;
  const showNewsletterEditor = Boolean(rawPrimaryNewsletter) && isNewsletterArtifactView;
  const deliveryStats = run?.stats?.delivery ?? null;
  const sentCount = deliveryStats?.successCount ?? run?.deliveryAction?.successCount ?? 0;
  const failureCount = deliveryStats?.failureCount ?? run?.deliveryAction?.failureCount ?? 0;
  const deliveryDryRun = deliveryStats?.dryRun === true;
  const deliveryFailed = deliveryDryRun || run?.deliveryAction?.status === "failed" || (failureCount > 0 && sentCount === 0);
  const deliveryStatusMessage = deliveryDryRun
    ? "Dry run only. Outbound email is disabled, so no email was sent."
    : deliveryFailed
      ? (deliveryStats?.error ?? "Resend broadcast failed or needs review.")
      : run?.deliveryAction?.status === "completed" || run?.stats?.delivery?.sentAt
        ? "Resend broadcast submitted."
        : "Contacts are syncing to Resend before the broadcast sends.";
  const recipientCount = run?.deliveryAction?.recipientCount ?? run?.stats?.contacts?.recipientCount ?? sentCount + failureCount;
  const openCount = deliveryStats?.openCount ?? 0;
  const clickCount = deliveryStats?.clickCount ?? 0;
  const totalClickCount = deliveryStats?.totalClickCount ?? clickCount;
  const unsubscribeCount = deliveryStats?.unsubscribeCount ?? 0;
  const openRate = deliveryStats?.openRate ?? (sentCount > 0 ? openCount / sentCount : 0);
  const clickRate = deliveryStats?.clickRate ?? (sentCount > 0 ? clickCount / sentCount : 0);
  const deliveryRate = recipientCount > 0 ? sentCount / recipientCount : 0;
  const metricsWebhook = deliveryStats?.metricsWebhook ?? null;
  const uploadedContacts = run?.stats?.contacts?.contacts ?? [];
  const contactDocumentRef = run?.stats?.contacts?.documentRef ?? null;
  const openTrackingHelpText =
    "Open tracking is best effort because Resend records an open only when the recipient loads the HTML tracking pixel.";
  const openTrackingSignalText = "Clicks are the stronger engagement signal.";
  const openTrackingWebhookText =
    metricsWebhook?.endpoint ?? "https://k17m9n29-3000.asse.devtunnels.ms/api/channels/webhooks/resend-events";
  const openTrackingWebhookNote =
    "No engagement webhooks have arrived yet. Confirm this run used a public HTTPS webhook URL and that Resend has email.opened and email.clicked selected.";
  const renderContactsDialog = (trigger: ReactNode) => (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[82vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Uploaded contacts</DialogTitle>
          <DialogDescription>
            {recipientCount} recipients uploaded{contactDocumentRef ? ` and saved as ${contactDocumentRef}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="border-b bg-slate-50 px-5 py-3">
          <p className="text-xs font-medium text-slate-500">Document ref</p>
          <p className="mt-1 break-all text-sm font-semibold text-slate-900">
            {contactDocumentRef ?? "Not available"}
          </p>
        </div>
        <ScrollArea className="max-h-[54vh]">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-white">
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uploadedContacts.length > 0 ? (
                uploadedContacts.map((contact, index) => (
                  <TableRow key={`${contact.email}-${index}`}>
                    <TableCell className="text-slate-500">{index + 1}</TableCell>
                    <TableCell className="font-medium text-slate-900">{contact.email}</TableCell>
                    <TableCell className="text-slate-600">{contact.name || "-"}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-slate-500">
                    No uploaded contacts are available on this run.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );

  useEffect(() => {
    if (draftDirty) return;
    setDraftEditor(rawPrimaryNewsletter || "");
  }, [draftDirty, rawPrimaryNewsletter]);

  useEffect(() => {
    if (!run?.emailTemplate?.html || emailSource === "builder") return;
    setEmailHtml(run.emailTemplate.html);
    setEmailDesign(run.emailTemplate.design ?? null);
    setEmailSource("builder");
  }, [emailSource, run?.emailTemplate?.design, run?.emailTemplate?.html]);

  useEffect(() => {
    if (!showNewsletterEditor || !draftEditor.trim() || emailSource === "builder") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setEmailPreviewBusy(true);
      void fetch(`/api/workflows/runs/${runId}/newsletter/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ body: draftEditor }),
      })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to render email preview");
          const html = typeof (payload as { html?: unknown }).html === "string" ? (payload as { html: string }).html : "";
          if (html) {
            setEmailHtml(html);
            setEmailSource("auto");
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Failed to render email preview");
        })
        .finally(() => {
          if (!controller.signal.aborted) setEmailPreviewBusy(false);
        });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [draftEditor, emailSource, runId, showNewsletterEditor]);

  useEffect(() => {
    if (!expandedTaskId) return;
    if (!agentTasks.some((task) => task.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
  }, [agentTasks, expandedTaskId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rRes, tRes, cRes, wRes, allRes, rosterRes, gatesRes] = await Promise.all([
        fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/tasks`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/comments`, { cache: "no-store" }),
        fetch(`/api/workflows/internal/loops/${workflowId}`, { cache: "no-store" }),
        fetch("/api/workflows", { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/roster`, { cache: "no-store" }),
        fetch(`/api/workflows/runs/${runId}/gates`, { cache: "no-store" }),
      ]);
      const [rP, tP, cP, wP, allP, rosterP, gatesP] = await Promise.all([
        rRes.json().catch(() => ({})),
        tRes.json().catch(() => ({})),
        cRes.json().catch(() => ({})),
        wRes.json().catch(() => ({})),
        allRes.json().catch(() => ({})),
        rosterRes.json().catch(() => ({})),
        gatesRes.json().catch(() => ({})),
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
      setGates(
        gatesRes.ok && Array.isArray((gatesP as { gates?: LoopRunGate[] }).gates)
          ? (gatesP as { gates: LoopRunGate[] }).gates
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
    if (loading) return;
    if (!run) return;

    const resumeFingerprint = [
      run.status,
      tasks.map((t) => `${t.id}:${t.status}`).join("|"),
      gates.map((g) => `${g.id}:${g.status}`).join("|"),
    ].join(";");

    const attemptResume = () => {
      if (resumeAttemptedRef.current === resumeFingerprint) return;
      resumeAttemptedRef.current = resumeFingerprint;
      void fetch(`/api/workflows/runs/${runId}/resume`, { method: "POST" })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            resumeAttemptedRef.current = null;
            throw new Error((payload as { error?: string }).error ?? "Failed to resume run");
          }
          await load();
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : "Failed to resume run");
        });
    };

    if (run.status === "executing_action" || run.status === "distributing") {
      attemptResume();
      return;
    }

    if (run.status === "waiting_for_gate" && !pendingApprovalGate(gates)) {
      attemptResume();
      return;
    }

    if (tasks.length === 0) return;
    if (run.status !== "strategy_approved" && run.status !== "running") return;

    const hasTodo = tasks.some((task) => task.status === "todo");
    const hasActive = tasks.some((task) => task.status === "in_progress" || task.status === "working");
    if (!hasTodo || hasActive) return;

    attemptResume();
  }, [loading, run, tasks, gates, runId, load]);

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

  async function resolvePendingGateId(): Promise<string | null> {
    if (pendingGate?.id) return pendingGate.id;
    const res = await fetch(`/api/workflows/runs/${runId}/gates`, { cache: "no-store" });
    const payload = await res.json().catch(() => ({}));
    const fetched = Array.isArray((payload as { gates?: LoopRunGate[] }).gates)
      ? (payload as { gates: LoopRunGate[] }).gates
      : [];
    return pendingApprovalGate(fetched)?.id ?? null;
  }

  async function doAction(action: RunAction) {
    setBusy(action);
    setError(null);
    try {
      if (action === "resume") {
        const res = await fetch(`/api/workflows/runs/${runId}/resume`, { method: "POST" });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to resume run");
        await load();
        return;
      }

      if (action === "approve-gate") {
        const gateId = await resolvePendingGateId();
        if (gateId) {
          const res = await fetch(`/api/workflows/runs/${runId}/gates/${gateId}/approve`, { method: "POST" });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to approve gate");
          await load();
          return;
        }
        const res = await fetch(`/api/workflows/runs/${runId}/approve`, { method: "POST" });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to approve run");
        await load();
        return;
      }

      const init: RequestInit = { method: "POST" };
      if (action === "approve-strategy" && roster.length > 0) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({ roster });
      }
      const res = await fetch(`/api/workflows/runs/${runId}/${action}`, init);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Action failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function rerunTask(taskId: string) {
    setBusy(`rerun:${taskId}`);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/tasks/${taskId}/rerun`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Failed to rerun stage");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rerun stage");
    } finally {
      setBusy(null);
    }
  }

  async function uploadCsvFile(file: File | null | undefined) {
    if (!file) return;
    setBusy("upload-contacts");
    setError(null);
    try {
      if ((draftDirty && draftEditor.trim()) || (emailSource === "builder" && emailHtml.trim())) {
        await saveNewsletterDraft({ keepBusy: true });
      }
      const csv = await file.text();
      const res = await fetch(`/api/workflows/runs/${runId}/contacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Failed to upload contacts");
      if (csvInputRef.current) csvInputRef.current.value = "";
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload contacts");
    } finally {
      setBusy(null);
    }
  }

  async function saveNewsletterDraft(options?: { keepBusy?: boolean; emailHtmlOverride?: string; emailDesignOverride?: unknown }) {
    if (!draftEditor.trim()) {
      setError("Newsletter body is required");
      throw new Error("Newsletter body is required");
    }
    if (!options?.keepBusy) setBusy("save-newsletter");
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/newsletter`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: draftEditor,
          ...(options?.emailHtmlOverride
            ? { emailHtml: options.emailHtmlOverride, emailDesign: options.emailDesignOverride ?? null }
            : emailSource === "builder" && emailHtml
              ? { emailHtml, emailDesign }
              : {}),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Failed to save newsletter");
      const updatedAt = new Date().toISOString();
      const savedEmailHtml = options?.emailHtmlOverride ?? (emailSource === "builder" && emailHtml ? emailHtml : "");
      const savedEmailDesign = options?.emailHtmlOverride
        ? options.emailDesignOverride ?? null
        : emailSource === "builder" && emailHtml
          ? emailDesign
          : null;
      setRun((current) => current ? {
        ...current,
        draftOutput: draftEditor,
        updatedAt,
        ...(savedEmailHtml
          ? {
            emailTemplate: {
              html: savedEmailHtml,
              design: savedEmailDesign,
              updatedAt,
            },
          }
          : {}),
      } : current);
      setDraftDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save newsletter");
      throw e;
    } finally {
      if (!options?.keepBusy) setBusy(null);
    }
  }

  async function saveBuilderEmail(html: string, design: unknown) {
    setEmailHtml(html);
    setEmailDesign(design);
    setEmailSource("builder");
    await saveNewsletterDraft({ emailHtmlOverride: html, emailDesignOverride: design });
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
  const agentTotal = agentTasks.length > 0
    ? agentTasks.length + (approvalGateInfo ? 1 : 0)
    : roster.length;

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
              <RunBadge status={runStatus} gates={gates} />
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
                      {decision.channels?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {decision.channels.map((channel) => (
                            <span key={channel} className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200">
                              {CHANNEL_LABELS[channel] ?? channel}
                            </span>
                          ))}
                        </div>
                      ) : null}
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

            {showCsvUpload ? (
              <Card className="shrink-0 gap-0 py-0 ring-0 shadow-md">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-100 shadow-sm">
                      <Upload className="size-5 text-sky-700" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">Upload recipients CSV</p>
                      <p className="mt-0.5 text-sm text-slate-600">
                        Use columns <code className="rounded bg-slate-100 px-1">email</code> and optional <code className="rounded bg-slate-100 px-1">name</code>. Uploading starts the Resend broadcast.
                      </p>
                      {run?.stats?.contacts ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span>{run.stats.contacts.recipientCount} recipients uploaded.</span>
                          {renderContactsDialog(
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 border-slate-300 px-2 text-xs text-slate-700 hover:bg-slate-100"
                            >
                              <Users className="size-3.5" />
                              View contacts
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={csvInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(event) => void uploadCsvFile(event.target.files?.[0])}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="bg-slate-900 text-white shadow-sm hover:bg-slate-800"
                      disabled={busy !== null}
                      onClick={() => csvInputRef.current?.click()}
                    >
                      {busy === "upload-contacts" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                      Upload CSV
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {run?.deliveryAction || run?.stats?.delivery ? (
              <Card className="shrink-0 gap-0 py-0 ring-0 shadow-md">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Broadcast delivery</p>
                    <p className="text-xs text-slate-500">
                      {deliveryStatusMessage}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
                      {run.deliveryAction?.recipientCount ?? run.stats?.contacts?.recipientCount ?? 0} recipients
                    </span>
                    <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-700">
                      {run.stats?.delivery?.successCount ?? run.deliveryAction?.successCount ?? 0} submitted
                    </span>
                    <span className="rounded-full bg-rose-100 px-2.5 py-1 text-rose-700">
                      {run.stats?.delivery?.failureCount ?? run.deliveryAction?.failureCount ?? 0} failed
                    </span>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-700">
                      {formatPercent(openRate)} open rate
                    </span>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">
                      {formatPercent(clickRate)} click rate
                    </span>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {run?.status === "waiting_for_strategy_approval" && !predefinedNewsletterRun && roster.length > 0 ? (
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
                      {run?.status === "waiting_for_strategy_approval" && !predefinedNewsletterRun
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

              <CardContent
                className={cn(
                  "min-h-0 flex flex-1 flex-col px-5 pb-6 pt-2",
                  showNewsletterEditor ? "overflow-hidden" : "overflow-y-auto"
                )}
              >
                {isPublicistView ? (
                  <div className="space-y-4">
                    {publicistMeta ? (
                      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-orange-100">
                          <Megaphone className="size-4 text-orange-700" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900">
                            {publicistMeta.emailApprovalSent ? "Approval email sent" : "Draft ready for approval"}
                          </p>
                          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                            {publicistMeta.to ? (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="size-3" />
                                {publicistMeta.to}
                              </span>
                            ) : null}
                            {publicistMeta.channel ? <span>Via {publicistMeta.channel}</span> : null}
                            {publicistMeta.sentAt ? <span>Sent {formatRelative(publicistMeta.sentAt)}</span> : null}
                          </div>
                        </div>
                        {publicistMeta.emailApprovalSent ? (
                          <span className="shrink-0 rounded-full bg-sky-100 px-2.5 py-0.5 text-[10px] font-semibold text-sky-700">
                            Awaiting response
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px rounded-xl bg-slate-200/50 shadow-sm overflow-hidden">
                      {[
                        { label: "Recipients", value: recipientCount, icon: Users, color: "text-slate-500" },
                        { label: deliveryDryRun ? "Not sent" : "Submitted", value: deliveryDryRun ? failureCount : sentCount, icon: Mail, color: deliveryDryRun ? "text-rose-600" : "text-sky-600" },
                        { label: "Open rate", value: formatPercent(openRate), icon: Eye, color: "text-amber-600" },
                        { label: "Click rate", value: formatPercent(clickRate), icon: MousePointerClick, color: "text-emerald-600" },
                        { label: "Unsubscribed", value: unsubscribeCount, icon: Users, color: "text-slate-500" },
                      ].map((stat) => (
                        <div key={stat.label} className="flex flex-col justify-center gap-0.5 bg-white px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <stat.icon className={cn("size-3.5", stat.color)} />
                            <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500">
                              {stat.label}
                              {stat.label === "Open rate" ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label="Open rate tracking details"
                                      className="inline-flex size-4 items-center justify-center rounded-full text-slate-400 transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                                    >
                                      <Info className="size-3.5" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    sideOffset={8}
                                    className="max-w-[340px] px-4 py-3 text-left leading-5"
                                  >
                                    <div className="space-y-3 text-[13px] leading-5">
                                      <p>{openTrackingHelpText}</p>
                                      <p>{openTrackingSignalText}</p>
                                      <div className="space-y-1.5">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/60">
                                          Metrics webhook
                                        </p>
                                        <code className="block break-all rounded-md bg-white/10 px-2 py-1.5 font-mono text-[11px] leading-4 text-white">
                                          {openTrackingWebhookText}
                                        </code>
                                      </div>
                                      <p className="text-[11px] leading-4 text-white/75">
                                        {openTrackingWebhookNote}
                                      </p>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                            </span>
                          </div>
                          <span className="flex items-center gap-2 text-lg font-semibold tabular-nums text-slate-900">
                            {stat.value}
                            {stat.label === "Recipients" && run?.stats?.contacts ? (
                              renderContactsDialog(
                                <button
                                  type="button"
                                  className="inline-flex size-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                                  aria-label="View uploaded contacts"
                                >
                                  <Users className="size-3.5" />
                                </button>
                              )
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>

                    {run?.deliveryAction || run?.stats?.delivery ? (
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                          <BarChart3 className="size-4 text-slate-600" />
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Engagement</p>
                        </div>
                        <div className="space-y-2.5">
                          {[
                            { label: "Delivery rate", pct: deliveryRate, color: "bg-sky-400" },
                            { label: "Open rate", pct: openRate, color: "bg-amber-400" },
                            { label: "Click rate", pct: clickRate, color: "bg-emerald-400" },
                          ].map((bar) => (
                            <div key={bar.label}>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-slate-600">
                                  {bar.label}
                                  {bar.label === "Open rate" ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <button
                                          type="button"
                                          aria-label="Open rate tracking details"
                                          className="inline-flex size-4 items-center justify-center rounded-full text-slate-400 transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                                        >
                                          <Info className="size-3.5" />
                                        </button>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="top"
                                        sideOffset={8}
                                        className="max-w-[340px] px-4 py-3 text-left leading-5"
                                      >
                                        <div className="space-y-3 text-[13px] leading-5">
                                          <p>{openTrackingHelpText}</p>
                                          <p>{openTrackingSignalText}</p>
                                          <div className="space-y-1.5">
                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/60">
                                              Metrics webhook
                                            </p>
                                            <code className="block break-all rounded-md bg-white/10 px-2 py-1.5 font-mono text-[11px] leading-4 text-white">
                                              {openTrackingWebhookText}
                                            </code>
                                          </div>
                                          <p className="text-[11px] leading-4 text-white/75">
                                            {openTrackingWebhookNote}
                                          </p>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : null}
                                </span>
                                <span className="font-semibold text-slate-900">{formatPercent(bar.pct)}</span>
                              </div>
                              <div className="h-2 rounded-full bg-slate-100">
                                <div className={`h-2 rounded-full ${bar.color}`} style={{ width: formatPercent(bar.pct) }} />
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="mt-3 text-xs text-slate-500">
                          {openCount} tracked opens, {clickCount} unique clicks, {totalClickCount} total clicks, {failureCount} failed deliveries.
                        </p>
                      </div>
                    ) : null}

                    {emailHtml ? (
                      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm h-full">
                        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{deliveryDryRun ? "Email dry run" : "Email submitted"}</p>
                        </div>
                        <iframe
                          title="Publicist email preview"
                          srcDoc={emailHtml}
                          className="h-full w-full bg-white"
                          sandbox=""
                        />
                      </div>
                    ) : null}

                    {centerOutput?.trim() ? (
                      <details className="group">
                        <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-slate-700">
                          Show raw markdown
                        </summary>
                        <article className="mt-3 rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                          {centerUpdatedAt ? (
                            <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                              Updated {formatRelative(centerUpdatedAt)}
                            </p>
                          ) : null}
                          <div className="text-sm leading-7 text-slate-800 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:mb-3.5 [&_strong]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc">
                            <Streamdown>{centerOutput}</Streamdown>
                          </div>
                        </article>
                      </details>
                    ) : null}
                  </div>
                ) : showNewsletterEditor ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <div className="flex shrink-0 items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Newsletter editor</p>
                        <p className="text-xs text-slate-500">
                          {emailSource === "builder"
                            ? "Custom visual email saved for this send."
                            : emailHtml
                              ? "Email preview generated from the newsletter draft."
                              : "Write the newsletter and build the visual email."}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={draftDirty ? "default" : "outline"}
                          className={draftDirty ? "bg-slate-900 text-white hover:bg-slate-800" : ""}
                          disabled={busy !== null || !draftDirty}
                          onClick={() => void saveNewsletterDraft()}
                        >
                          {busy === "save-newsletter" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEmailBuilderOpen(true)}
                        >
                          <Code className="size-3.5" />
                          {emailSource === "builder" ? "Edit email" : "Open Builder"}
                        </Button>
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Email preview</p>
                        <span className="text-[10px] font-medium text-slate-500">
                          {emailPreviewBusy ? "Rendering..." : emailSource === "builder" ? "Builder HTML" : "Generated HTML"}
                        </span>
                      </div>
                      <div className="relative min-h-0 flex-1">
                        {emailHtml ? (
                          <iframe
                            title="Writer email preview"
                            srcDoc={emailHtml}
                            className="absolute inset-0 h-full w-full bg-white"
                            sandbox=""
                          />
                        ) : (
                          <div className="grid h-full place-items-center px-4 text-center text-sm text-slate-500">
                            {emailPreviewBusy ? "Building email preview..." : "Newsletter content will render here."}
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                ) : centerOutput?.trim() ? (
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
                          {active ? "Click an agent row to view its output here." : "Start a new run to generate output."}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </main>

          <aside className="hidden w-[380px] shrink-0 flex-col gap-3 overflow-hidden lg:flex">
            <ScrollArea className="h-full pr-1">
              <div className="space-y-3">
                <Card className="gap-3 py-4 ring-0 shadow-md">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm text-slate-900">Artifacts</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 px-3">
                    <button
                      type="button"
                      onClick={() => setExpandedTaskId(null)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm transition-colors",
                        expandedTaskId === null
                          ? "border-slate-900 text-slate-900"
                          : "border-slate-200 text-slate-700 hover:border-slate-300"
                      )}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100">
                        <FileText className="size-3.5" />
                      </span>
                      <span className="flex-1 text-sm font-semibold">Newsletter</span>
                      <ChevronLeft className={cn("size-4 shrink-0", expandedTaskId === null ? "text-slate-900" : "text-slate-400")} />
                    </button>
                  </CardContent>
                </Card>

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
                      statusLabel={prettyStatus(runStatus, gates)}
                      runStatus={runStatus}
                    />
                    {approvalGateInfo ? <ApprovalGateRow gate={approvalGateInfo} /> : null}
                    {loading && agentTasks.length === 0 && roster.length === 0 ? (
                      <AgentPlaceholder />
                    ) : agentTasks.length > 0 ? (
                      agentTasks.map((task) => (
                          <AgentRow
                          key={task.id}
                          task={task}
                          open={isAgentRowOpen(task, expandedTaskId)}
                          canRerun={runStatus !== "executing_action" && runStatus !== "distributing" && task.status !== "in_progress" && task.status !== "todo"}
                          rerunning={busy === `rerun:${task.id}`}
                          onRerun={() => void rerunTask(task.id)}
                          onToggle={() => {
                            if (isWriterTask(task)) {
                              setExpandedTaskId(null);
                              return;
                            }
                            setExpandedTaskId((current) => (current === task.id ? null : task.id));
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

        <EmailBuilderDialog
          open={emailBuilderOpen}
          onClose={() => setEmailBuilderOpen(false)}
          initialDesign={emailDesign ?? undefined}
          initialHtml={emailHtml || undefined}
          initialMarkdown={draftEditor || undefined}
          initialSubject={parseNewsletterSubjectAndGreeting(draftEditor).subject}
          initialGreeting={parseNewsletterSubjectAndGreeting(draftEditor).greeting}
          onSave={saveBuilderEmail}
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

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
import { GateActionPanel } from "./components/gate-action-panel";
import {
  CHANNEL_LABELS,
  contentPanelLabel,
  engineGateStatusLabel,
  gateApprovalChannels,
  getTaskOutput,
  isApprovalTask,
  isBroadcastDeliveryTask,
  isEmailBuildTask,
  isEngineV3Workflow,
  isNewsletterDeliveryWorkflow,
  isNewsletterPresetWorkflow,
  isDraftArtifactTask,
  isWriterTask,
  looksLikeMissingInputPrompt,
  readEngineGateType,
  readGateDraft,
  readRecord,
  stripMarkdown,
  type LoopRunGateView,
  type WorkflowDefinition,
} from "./components/run-view-utils";
import { ChatDrawer, type ChatComment } from "./components/chat-drawer";
import { EmailBuilderDialog } from "./components/email-builder-dialog";
import { NewsletterMetadataPanel } from "./components/newsletter-metadata-panel";
import {
  formatNewsletterMetadataSummary,
  resolveNewsletterSendMetadata,
} from "./components/newsletter-metadata";
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
  definition?: WorkflowDefinition & {
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
    requestedAt?: string | null;
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
    approval?: {
      requestedTo: string | null;
      requestedAt: string | null;
      approvedAt: string | null;
      channel: string | null;
    } | null;
    contacts: {
      uploadedAt: string | null;
      recipientCount: number;
      documentRef?: string | null;
      lotRef?: string | null;
      contacts?: Array<{ email: string; name: string | null }>;
    } | null;
    delivery: {
      sentAt: string | null;
      broadcastId?: string | null;
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
    subject?: string | null;
    preview?: string | null;
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

type LoopRunGate = LoopRunGateView & {
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
  "executing_action",
  "distributing",
  "waiting_for_contact_list",
]);

function pendingApprovalGate(gates: LoopRunGate[]): LoopRunGate | null {
  return gates.find((gate) => gate.status === "pending" && readEngineGateType(gate.payload))
    ?? gates.find((gate) => gate.kind === "approval" && gate.status === "pending" && !readEngineGateType(gate.payload))
    ?? null;
}

function pendingEngineGateForRun(gates: LoopRunGate[]): LoopRunGate | null {
  return gates.find((gate) => gate.status === "pending" && readEngineGateType(gate.payload)) ?? null;
}

function resolveEffectiveEngineGate(
  gates: LoopRunGate[],
  run: LoopRun | null,
): LoopRunGate | null {
  const fromGates = pendingEngineGateForRun(gates);
  if (fromGates) return fromGates;
  if (run?.pendingInput?.status !== "pending") return null;
  const matchedGate = gates.find((gate) => gate.id === run.pendingInput?.id && gate.status === "pending");
  if (!matchedGate) return null;
  return matchedGate;
}

function pendingLegacyGateForRun(gates: LoopRunGate[]): LoopRunGate | null {
  return gates.find((gate) => gate.kind === "approval" && gate.status === "pending" && !readEngineGateType(gate.payload)) ?? null;
}

function isApprovalRunTask(task: LoopRunTask): boolean {
  return isApprovalTask(task);
}

function rosterHasDedicatedApprovalAgent(tasks: LoopRunTask[]): boolean {
  return tasks.some((task) =>
    (task.assignedTools ?? []).some((tool) => tool.ref === "internal.email_approval_request"),
  );
}

function isWriterRunTask(task: LoopRunTask): boolean {
  return isWriterTask(task);
}

function hasDraftReady(run: LoopRun | null, tasks: LoopRunTask[]): boolean {
  if (run?.draftOutput?.trim()) return true;
  return tasks.some(
    (task) => isWriterRunTask(task)
      && (task.status === "done" || task.status === "completed")
      && getTaskOutput(task).length > 0,
  );
}

function needsRunApproval(
  run: LoopRun | null,
  gates: LoopRunGate[],
  tasks: LoopRunTask[],
  isV3: boolean,
): boolean {
  if (!run) return false;
  if (isV3) {
    if (pendingEngineGateForRun(gates)) return false;
    if (run.status === "waiting_for_email_approval") return true;
    return false;
  }
  if (pendingLegacyGateForRun(gates)) return true;
  if (run.status === "waiting_for_approval" || run.status === "waiting_for_email_approval") return true;
  if (!hasDraftReady(run, tasks)) return false;

  const approvalTask = tasks.find(isApprovalRunTask);
  if (run.status === "blocked") {
    if (approvalTask && (approvalTask.status === "blocked" || approvalTask.status === "in_progress")) {
      return true;
    }
    const writerDone = tasks.some(
      (task) => isWriterRunTask(task) && (task.status === "done" || task.status === "completed"),
    );
    const approvalPending = tasks.some(
      (task) => isApprovalRunTask(task) && (task.status === "todo" || task.status === "blocked"),
    );
    return writerDone && approvalPending;
  }

  return false;
}

function isAwaitingApprovalStatus(
  status: string,
  gates: LoopRunGate[],
  tasks: LoopRunTask[] = [],
  run: LoopRun | null = null,
  isV3 = false,
): boolean {
  if (needsRunApproval(run, gates, tasks, isV3)) return true;
  if (status === "waiting_for_approval" || status === "waiting_for_email_approval") {
    return true;
  }
  if (pendingEngineGateForRun(gates)) return true;
  if (!isV3 && pendingLegacyGateForRun(gates)) return true;
  return false;
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

function prettyStatus(
  s: string,
  gates: LoopRunGate[] = [],
  tasks: LoopRunTask[] = [],
  run: LoopRun | null = null,
  isV3 = false,
) {
  const engineGate = pendingEngineGateForRun(gates);
  if (engineGate) return engineGateStatusLabel(readEngineGateType(engineGate.payload));
  if (needsRunApproval(run, gates, tasks, isV3) || pendingLegacyGateForRun(gates)) return "awaiting approval";
  if (s === "waiting_for_email_approval" || s === "waiting_for_approval") return "awaiting approval";
  if (s === "waiting_for_contact_list") return "awaiting contacts";
  if (s === "waiting_for_input") return "awaiting input";
  if (s === "waiting_for_gate") return "waiting for gate";
  return s.replace(/_/g, " ");
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

function statusBadgeClass(
  s: string,
  gates: LoopRunGate[] = [],
  tasks: LoopRunTask[] = [],
  run: LoopRun | null = null,
  isV3 = false,
) {
  if (s === "completed" || s === "done") return "bg-sky-100 text-sky-800";
  if (s === "running" || s === "strategy_approved") return "bg-blue-100 text-blue-800";
  if (s.includes("waiting") || isAwaitingApprovalStatus(s, gates, tasks, run, isV3)) return "bg-amber-100 text-amber-800";
  if (s === "blocked" && needsRunApproval(run, gates, tasks, isV3)) return "bg-amber-100 text-amber-800";
  if (pendingEngineGateForRun(gates)) return "bg-amber-100 text-amber-800";
  if (s === "blocked" || s === "failed") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function isBroadcastRunTask(task: LoopRunTask): boolean {
  return isBroadcastDeliveryTask(task);
}

function isDeliveryExecutionSettled(run: LoopRun | null, tasks: LoopRunTask[]): boolean {
  if (!run) return false;
  const deliveryStatus = run.deliveryAction?.status ?? "";
  if (["completed", "partial_failure", "failed"].includes(deliveryStatus)) return true;
  if (run.deliveryAction?.broadcastId) return true;
  return tasks.some(
    (task) => isBroadcastRunTask(task) && (task.status === "done" || task.status === "completed"),
  );
}

function isApprovalAgentTask(task: AgentRowTask): boolean {
  return isApprovalTask(task);
}

function isEmailBuildAgentTask(task: AgentRowTask): boolean {
  return isEmailBuildTask(task);
}

function getEmailBuildHtml(task: AgentRowTask): string | null {
  const out = readRecord(task.outputJson);
  const template = readRecord(out.emailTemplate);
  return typeof template.html === "string" && template.html.trim() ? template.html : null;
}

function readEmailTemplateRecord(source: unknown) {
  const record = readRecord(source);
  return {
    subject: typeof record.subject === "string" ? record.subject : null,
    preview: typeof record.preview === "string" ? record.preview : null,
    html: typeof record.html === "string" ? record.html : null,
  };
}

function resolveRunNewsletterMetadata(input: {
  markdown: string;
  task: AgentRowTask | null;
  run: LoopRun | null;
  html?: string | null;
}) {
  const taskTemplate = input.task ? readEmailTemplateRecord(readRecord(input.task.outputJson).emailTemplate) : null;
  const runTemplate = input.run?.emailTemplate
    ? {
        subject: input.run.emailTemplate.subject ?? null,
        preview: input.run.emailTemplate.preview ?? null,
        html: input.run.emailTemplate.html ?? null,
      }
    : null;
  return resolveNewsletterSendMetadata({
    markdown: input.markdown,
    emailTemplate: {
      subject: taskTemplate?.subject ?? runTemplate?.subject ?? null,
      preview: taskTemplate?.preview ?? runTemplate?.preview ?? null,
      html: taskTemplate?.html ?? runTemplate?.html ?? input.html ?? null,
    },
  });
}

function getAgentMetadataSummary(
  task: AgentRowTask,
  draftMarkdown: string,
  run: LoopRun | null,
): string | null {
  if (isWriterTask(task)) {
    const markdown = getTaskOutput(task) || draftMarkdown;
    return formatNewsletterMetadataSummary(resolveNewsletterSendMetadata({ markdown }));
  }
  if (isEmailBuildAgentTask(task)) {
    return formatNewsletterMetadataSummary(resolveRunNewsletterMetadata({
      markdown: draftMarkdown,
      task,
      run,
    }));
  }
  return null;
}

function getBroadcastDeliveryOutput(task: AgentRowTask, run: LoopRun | null): string {
  const out = readRecord(task.outputJson);
  if (typeof out.text === "string" && out.text.trim()) return out.text.trim();
  const distribution = readRecord(out.distribution);
  const broadcastId = typeof distribution.broadcastId === "string"
    ? distribution.broadcastId
    : run?.deliveryAction?.broadcastId ?? null;
  const successCount = typeof out.successCount === "number"
    ? out.successCount
    : run?.stats?.delivery?.successCount ?? run?.deliveryAction?.successCount ?? 0;
  const failureCount = typeof out.failureCount === "number"
    ? out.failureCount
    : run?.stats?.delivery?.failureCount ?? run?.deliveryAction?.failureCount ?? 0;
  const recipientCount = run?.deliveryAction?.recipientCount ?? run?.stats?.contacts?.recipientCount ?? 0;
  if (task.status === "in_progress") {
    return recipientCount > 0
      ? `Syncing ${recipientCount} recipient(s) and submitting the Resend broadcast…`
      : "Waiting for recipient upload before broadcast delivery can run.";
  }
  if (broadcastId || successCount > 0 || failureCount > 0) {
    return [
      `Resend broadcast ${broadcastId ?? "pending"}: ${successCount} submitted, ${failureCount} failed.`,
      typeof distribution.provider === "string" ? `Provider: ${distribution.provider}` : null,
    ].filter(Boolean).join("\n");
  }
  const inp = readRecord(task.inputJson);
  const agent = readRecord(inp.agent);
  if (typeof agent.task === "string" && agent.task.trim()) return agent.task.trim();
  return "Broadcast delivery has not run yet.";
}

function isAgentRowOpen(task: AgentRowTask, expandedTaskId: string | null): boolean {
  return expandedTaskId === task.id;
}

function getApprovalMeta(task: AgentRowTask, run: LoopRun | null) {
  const out = readRecord(task.outputJson);
  const req = readRecord(out.approvalRequest);
  const runApproval = run?.stats?.approval ?? null;
  return {
    to: typeof req.to === "string" ? req.to : runApproval?.requestedTo ?? null,
    channel: typeof req.channel === "string" ? req.channel : runApproval?.channel ?? null,
    sentAt: typeof req.sentAt === "string" ? req.sentAt : runApproval?.requestedAt ?? null,
    approvedAt: runApproval?.approvedAt ?? null,
    artifactBody: typeof out.artifactBody === "string" ? out.artifactBody : null,
    emailApprovalSent: out.emailApprovalSent === true || Boolean(runApproval?.requestedAt ?? req.sentAt),
    summary: typeof out.text === "string" && out.text.trim()
      ? out.text.trim()
      : task.latestComment?.body?.trim() ?? "",
  };
}

function getApprovalAgentOutput(task: AgentRowTask, run: LoopRun | null): string {
  const meta = getApprovalMeta(task, run);
  if (meta.summary && !/\bbroadcast\b/i.test(meta.summary)) return meta.summary;
  if (meta.approvedAt) {
    return "You approved this email. Recipient sync and Resend broadcast delivery run separately in the Broadcast Delivery Agent.";
  }
  if (meta.to && meta.sentAt) {
    return `Approval request sent to ${meta.to}. The preview below is the email submitted for your review — it is not the subscriber broadcast.`;
  }
  return getTaskOutput(task);
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
  isV3: boolean,
): boolean {
  if (!run || run.status !== "running" || isV3) return false;
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
  isV3: boolean,
): {
  show: boolean;
  headline: string;
  sub: string;
  cta: string;
  action: RunAction;
  tone: "amber" | "sky" | "rose";
  channels?: string[];
  notifyChannels?: boolean;
} | null {
  const status = run?.status ?? "";
  const engineGate = pendingEngineGateForRun(gates);
  const legacyGate = pendingLegacyGateForRun(gates);
  const gateChannels = gateApprovalChannels(legacyGate);

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
  if (engineGate) {
    return null;
  }
  if (legacyGate) {
    const channelText = gateChannels.map((c) => CHANNEL_LABELS[c] ?? c).join(", ");
    return {
      show: true,
      headline: legacyGate.title,
      sub: `Approval required via ${channelText}. Review the draft, then approve to continue.`,
      cta: "Approve",
      action: "approve-gate",
      tone: "sky",
      channels: gateChannels,
    };
  }
  if (needsRunApproval(run, gates, tasks, isV3)) {
    const channelSent = Boolean(run?.stats?.approval?.requestedAt);
    const channelLabel = run?.stats?.approval?.requestedTo ?? run?.stats?.approval?.channel ?? null;
    const approvalAgentHandlesNotify = rosterHasDedicatedApprovalAgent(tasks);
    return {
      show: true,
      headline: status === "blocked" ? "Newsletter draft ready for approval" : "Newsletter is ready for approval",
      sub: channelSent
        ? `Approval sent to ${channelLabel ?? "your notification channel"}. Review the draft, then approve to continue.`
        : approvalAgentHandlesNotify
          ? firstSentence(run?.draftOutput, "Review and approve this newsletter. The approval agent will send one notification email.")
          : firstSentence(run?.draftOutput, "Review and approve this newsletter. We'll notify your configured channel."),
      cta: "Approve newsletter",
      action: "approve",
      tone: "sky",
      notifyChannels: !channelSent && !approvalAgentHandlesNotify,
    };
  }
  if (status === "blocked" && !isV3) {
    return {
      show: true,
      headline: "Run needs a decision",
      sub: "Use steer or reject the gate to continue.",
      cta: "Skip this run",
      action: "skip",
      tone: "rose",
    };
  }
  if (needsApprovalHandoffContinue(run, tasks, gates, isV3)) {
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

function RunBadge({
  status,
  gates = [],
  tasks = [],
  run = null,
  isV3 = false,
}: {
  status: string;
  gates?: LoopRunGate[];
  tasks?: LoopRunTask[];
  run?: LoopRun | null;
  isV3?: boolean;
}) {
  const isRunning = status === "running" || status === "strategy_approved";
  const awaiting = isAwaitingApprovalStatus(status, gates, tasks, run, isV3);
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-0 capitalize shadow-none", statusBadgeClass(status, gates, tasks, run, isV3))}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          awaiting ? "bg-amber-500" :
          status === "completed" ? "bg-sky-500" :
          isRunning ? "bg-blue-500 animate-pulse" :
          "bg-muted-foreground/50"
        )}
      />
      {prettyStatus(status, gates, tasks, run, isV3)}
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
  const [debugLogsOpen, setDebugLogsOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<unknown>(null);
  const [debugLogsLoading, setDebugLogsLoading] = useState(false);
  const resumeAttemptedRef = useRef<string | null>(null);
  const approvalNotifyAttemptedRef = useRef<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const broadcastTaskInProgress = tasks.some(
    (task) => isBroadcastRunTask(task) && task.status === "in_progress",
  );
  const active = run
    ? ACTIVE_STATUSES.has(run.status) || broadcastTaskInProgress
    : false;
  const runStatus = run?.status ?? "loading";
  const wfStatus = workflow?.status ?? "active";
  const workflowDefinition = workflow?.definition ?? null;
  const isV3 = isEngineV3Workflow(workflowDefinition);
  const decision = runAction(run, gates, tasks, isV3);
  const pendingGate = pendingApprovalGate(gates);
  const engineGate = resolveEffectiveEngineGate(gates, run);
  const engineGateType = engineGate ? readEngineGateType(engineGate.payload) : null;
  const runPausedForGate = Boolean(
    engineGate
    || run?.status === "waiting_for_gate"
    || run?.pendingInput?.status === "pending",
  );
  const approvalGateInfo: ApprovalGateInfo | null = pendingGate
    ? {
        id: pendingGate.id,
        title: pendingGate.title,
        artifactId: pendingGate.artifactId,
        channels: readEngineGateType(pendingGate.payload) ? [] : gateApprovalChannels(pendingGate),
        status: pendingGate.status,
        gateType: readEngineGateType(pendingGate.payload),
      }
    : null;
  const predefinedNewsletterRun = isNewsletterPresetWorkflow(workflowDefinition);
  const newsletterDeliveryWorkflow = isNewsletterDeliveryWorkflow(workflowDefinition);
  const showCsvUpload = !isV3 && (runStatus === "waiting_for_contact_list" || runStatus === "waiting_for_input");
  const showDeliveryMetrics = newsletterDeliveryWorkflow;

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
  const writerTask = [...agentTasks].reverse().find(isDraftArtifactTask) ?? null;
  const gateDraftContent = engineGate ? readGateDraft(engineGate.payload) : null;
  const rawPrimaryNewsletter = (() => {
    if (gateDraftContent) return gateDraftContent;
    const runDraft = run?.draftOutput?.trim() ?? "";
    const writerOutput = writerTask ? getTaskOutput(writerTask) : "";
    if (isV3 && writerOutput && !looksLikeMissingInputPrompt(writerOutput)) {
      return writerOutput;
    }
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
    : activeAgentTask && isBroadcastDeliveryTask(activeAgentTask)
      ? getBroadcastDeliveryOutput(activeAgentTask, run)
      : activeAgentTask && isApprovalAgentTask(activeAgentTask)
        ? getApprovalAgentOutput(activeAgentTask, run)
        : activeAgentTask
          ? getTaskOutput(activeAgentTask)
          : rawPrimaryNewsletter || null;
  const centerUpdatedAt = activeAgentTask ? activeAgentTask.completedAt ?? activeAgentTask.startedAt : run?.updatedAt ?? linkedLatestRun?.createdAt ?? null;
  const isApprovalView = Boolean(activeAgentTask && isApprovalAgentTask(activeAgentTask));
  const isEmailBuildView = Boolean(activeAgentTask && isEmailBuildAgentTask(activeAgentTask));
  const isBroadcastView = Boolean(activeAgentTask && isBroadcastDeliveryTask(activeAgentTask));
  const approvalMeta = isApprovalView && activeAgentTask ? getApprovalMeta(activeAgentTask, run) : null;
  const emailBuildHtml = isEmailBuildView && activeAgentTask ? getEmailBuildHtml(activeAgentTask) ?? emailHtml : null;
  const approvalPreviewHtml = isApprovalView && newsletterDeliveryWorkflow ? emailHtml : null;
  const isNewsletterArtifactView = !activeAgentTask;
  const showDraftContent = Boolean(rawPrimaryNewsletter) && isNewsletterArtifactView
    && (newsletterDeliveryWorkflow || (isV3 && engineGateType === "draft_review"));
  const showNewsletterEditor = showDraftContent && newsletterDeliveryWorkflow;
  const showGenericDraftView = showDraftContent && !newsletterDeliveryWorkflow && engineGateType !== "missing_input";
  const showMissingInputInCenter = Boolean(
    engineGateType === "missing_input"
    || (isV3 && !engineGate && looksLikeMissingInputPrompt(centerOutput)),
  );
  const panelLabel = contentPanelLabel({
    definition: workflowDefinition,
    engineGateType,
    waitingForStrategy: runStatus === "waiting_for_strategy_approval",
    predefinedNewsletter: predefinedNewsletterRun,
  });
  const newsletterSendMetadata = useMemo(() => resolveRunNewsletterMetadata({
    markdown: rawPrimaryNewsletter,
    task: isEmailBuildView ? activeAgentTask : writerTask,
    run,
    html: emailBuildHtml ?? emailHtml,
  }), [rawPrimaryNewsletter, isEmailBuildView, activeAgentTask, writerTask, run, emailBuildHtml, emailHtml]);
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

  const loadDebugLogs = useCallback(async () => {
    setDebugLogsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/logs`, { cache: "no-store" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to load run logs");
      setDebugLogs((payload as { logs?: unknown }).logs ?? payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load run logs");
    } finally {
      setDebugLogsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (loading || !run || !decision?.notifyChannels || isV3) return;
    if (rosterHasDedicatedApprovalAgent(tasks)) return;
    if (approvalNotifyAttemptedRef.current === run.id) return;
    approvalNotifyAttemptedRef.current = run.id;
    void fetch(`/api/workflows/runs/${runId}/request-approval`, { method: "POST" })
      .then((res) => (res.ok ? load() : undefined))
      .catch(() => undefined);
  }, [loading, run, decision?.notifyChannels, runId, load, tasks, isV3]);

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
      const broadcastTask = tasks.find(isBroadcastRunTask);
      const broadcastTaskDone = Boolean(
        broadcastTask && (broadcastTask.status === "done" || broadcastTask.status === "completed"),
      );
      if (isDeliveryExecutionSettled(run, tasks) && broadcastTaskDone) return;
      attemptResume();
      return;
    }

    if (
      run.status === "waiting_for_gate"
      || resolveEffectiveEngineGate(gates, run)
      || pendingLegacyGateForRun(gates)
      || run.pendingInput?.status === "pending"
    ) {
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

  async function approveEngineGate(gateId: string, decision: Record<string, unknown>) {
    setBusy("approve-gate");
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/gates/${gateId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to approve gate");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve gate");
    } finally {
      setBusy(null);
    }
  }

  async function rejectEngineGate(gateId: string) {
    setBusy("reject-gate");
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/gates/${gateId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Rejected by operator" }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to reject gate");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reject gate");
    } finally {
      setBusy(null);
    }
  }

  async function submitEngineGateInput(gateId: string, value: string) {
    setBusy("gate-input");
    setError(null);
    try {
      const res = await fetch(`/api/workflows/runs/${runId}/gates/${gateId}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Failed to submit gate input");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit gate input");
    } finally {
      setBusy(null);
    }
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

      if (action === "skip") {
        if (engineGate) {
          await rejectEngineGate(engineGate.id);
          return;
        }
        throw new Error("Skip is not available for this run");
      }

      if (action === "approve-gate") {
        const gateId = await resolvePendingGateId();
        if (gateId) {
          const gate = gates.find((row) => row.id === gateId) ?? pendingApprovalGate(gates);
          const gateType = gate ? readEngineGateType(gate.payload) : null;
          if (gateType) {
            await approveEngineGate(gateId, { approvedAt: new Date().toISOString(), channel: "ui" });
            return;
          }
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
      if (draftDirty) {
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
    const bodyToSave = draftEditor.trim() || rawPrimaryNewsletter.trim() || run?.draftOutput?.trim() || "";
    if (!bodyToSave) {
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
          body: bodyToSave,
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
        draftOutput: bodyToSave,
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
                    <Link href={`/dashboard/loops/${workflowId}`} className="text-xs">{workflow?.title ?? "Loop"}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-xs">Run {run?.id ? run.id.slice(0, 6) : "…"}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-slate-900">{workflow?.title ?? panelLabel}</h1>
              <RunBadge status={runStatus} gates={gates} tasks={tasks} run={run} isV3={isV3} />
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
                  onClick={() => {
                    setDebugLogsOpen(true);
                    void loadDebugLogs();
                  }}
                  disabled={debugLogsLoading}
                  aria-label="Run logs"
                  className="text-slate-500 hover:bg-white hover:text-slate-900"
                >
                  {debugLogsLoading ? <Loader2 className="size-4 animate-spin" /> : <Code className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run logs</TooltipContent>
            </Tooltip>

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
                  disabled={busy !== null || runStatus === "completed" || (!engineGate && isV3)}
                  onClick={() => void doAction("skip")}
                >
                  <XCircle className="size-4" />
                  {engineGate ? "Reject gate" : "Skip run"}
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

            {engineGate ? (
              <GateActionPanel
                gateId={engineGate.id}
                title={engineGate.title}
                payload={engineGate.payload}
                busy={busy !== null}
                prominent={engineGateType === "missing_input"}
                onApprove={(decision) => approveEngineGate(engineGate.id, decision)}
                onReject={() => rejectEngineGate(engineGate.id)}
                onSubmitInput={(value) => submitEngineGateInput(engineGate.id, value)}
              />
            ) : null}

            {decision && !engineGate ? (
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

            {showDeliveryMetrics && !isApprovalView && !isEmailBuildView && (run?.deliveryAction || run?.stats?.delivery) ? (
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
                      {panelLabel}
                    </span>
                    <CardDescription className="text-slate-600">
                      {run?.status === "waiting_for_strategy_approval" && !predefinedNewsletterRun
                        ? "CEO strategy proposal"
                        : activeAgentTask
                          ? `${activeAgentTask.agentName} output`
                          : engineGateType === "draft_review"
                            ? "Review the draft below"
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
                      Show {panelLabel.toLowerCase()}
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
                {isBroadcastView ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-orange-100">
                        <Megaphone className="size-4 text-orange-700" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">Broadcast delivery</p>
                        <p className="mt-0.5 text-sm text-slate-600">{deliveryStatusMessage}</p>
                      </div>
                      <span className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
                        activeAgentTask?.status === "in_progress" ? "bg-blue-100 text-blue-700" : "bg-sky-100 text-sky-700",
                      )}>
                        {activeAgentTask?.status === "in_progress" ? "Working" : activeAgentTask?.status === "done" || activeAgentTask?.status === "completed" ? "Complete" : "Queued"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl bg-slate-200/50 shadow-sm overflow-hidden">
                      {[
                        { label: "Recipients", value: recipientCount },
                        { label: deliveryDryRun ? "Not sent" : "Submitted", value: deliveryDryRun ? failureCount : sentCount },
                        { label: "Failed", value: failureCount },
                        { label: "Broadcast ID", value: run?.deliveryAction?.broadcastId ?? run?.stats?.delivery?.broadcastId ?? "Pending" },
                      ].map((stat) => (
                        <div key={stat.label} className="flex flex-col justify-center gap-0.5 bg-white px-4 py-3">
                          <span className="text-[11px] font-medium text-slate-500">{stat.label}</span>
                          <span className="text-sm font-semibold tabular-nums text-slate-900 break-all">{stat.value}</span>
                        </div>
                      ))}
                    </div>
                    {centerOutput?.trim() ? (
                      <article className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Resend delivery output</p>
                        <div className="text-sm leading-7 text-slate-800 whitespace-pre-wrap">{centerOutput}</div>
                      </article>
                    ) : null}
                  </div>
                ) : isEmailBuildView ? (
                  <div className="space-y-4">
                    <NewsletterMetadataPanel metadata={newsletterSendMetadata} title="Built email metadata" />
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-100">
                        <Mail className="size-4 text-amber-700" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">Email build complete</p>
                        <p className="mt-0.5 text-xs text-slate-500">Visual email rendered from the writer draft. Approval runs in the next agent.</p>
                      </div>
                    </div>
                    {emailBuildHtml ? (
                      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm min-h-[420px]">
                        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Built email preview</p>
                        </div>
                        <iframe
                          title="Built email preview"
                          srcDoc={emailBuildHtml}
                          className="h-[520px] w-full bg-white"
                          sandbox=""
                        />
                      </div>
                    ) : centerOutput?.trim() ? (
                      <article className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                        <div className="text-sm leading-7 text-slate-800">
                          <Streamdown>{centerOutput}</Streamdown>
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : isApprovalView ? (
                  <div className="space-y-4">
                    {approvalMeta ? (
                      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-100">
                          <ShieldCheck className="size-4 text-amber-700" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900">
                            {approvalMeta.approvedAt
                              ? "Email approved"
                              : approvalMeta.emailApprovalSent
                                ? "Approval request sent"
                                : "Draft ready for approval"}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            This agent only handles review and approval. Subscriber broadcast delivery runs in the Broadcast Delivery Agent.
                          </p>
                          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                            {approvalMeta.to ? (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="size-3" />
                                {approvalMeta.to}
                              </span>
                            ) : null}
                            {approvalMeta.channel ? <span>Via {approvalMeta.channel}</span> : null}
                            {approvalMeta.approvedAt ? (
                              <span>Approved {formatRelative(approvalMeta.approvedAt)}</span>
                            ) : approvalMeta.sentAt ? (
                              <span>Sent {formatRelative(approvalMeta.sentAt)}</span>
                            ) : null}
                          </div>
                        </div>
                        <span className={cn(
                          "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
                          approvalMeta.approvedAt
                            ? "bg-sky-100 text-sky-700"
                            : approvalMeta.emailApprovalSent
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-700",
                        )}>
                          {approvalMeta.approvedAt ? "Approved" : approvalMeta.emailApprovalSent ? "Awaiting response" : "Pending"}
                        </span>
                      </div>
                    ) : null}

                    {centerOutput?.trim() ? (
                      <article className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Approval agent output</p>
                        <div className="text-sm leading-7 text-slate-800 whitespace-pre-wrap">{centerOutput}</div>
                      </article>
                    ) : null}

                    {approvalPreviewHtml ? (
                      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm min-h-[420px]">
                        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Email submitted for approval</p>
                        </div>
                        <iframe
                          title="Email submitted for approval"
                          srcDoc={approvalPreviewHtml}
                          className="h-[520px] w-full bg-white"
                          sandbox=""
                        />
                      </div>
                    ) : null}
                  </div>
                ) : showMissingInputInCenter && !engineGate && !run?.activeGateId ? (
                  <div className="rounded-xl border border-sky-200 bg-sky-50/50 px-5 py-5 text-sm text-slate-700">
                    <p className="font-medium text-slate-900">Waiting for your input</p>
                    <p className="mt-2">This run needs sprint notes before it can continue. If you do not see an input box above, refresh the page — the run should pause momentarily.</p>
                  </div>
                ) : showGenericDraftView ? (
                  <article className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
                    {centerUpdatedAt ? (
                      <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                        Updated {formatRelative(centerUpdatedAt)}
                      </p>
                    ) : null}
                    <div className="text-sm leading-7 text-slate-800 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:mb-3.5 [&_strong]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc">
                      <Streamdown>{rawPrimaryNewsletter}</Streamdown>
                    </div>
                  </article>
                ) : showNewsletterEditor ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <NewsletterMetadataPanel metadata={newsletterSendMetadata} title="Newsletter metadata" />
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
                        <p className="mt-4 text-sm font-medium text-slate-800">No {panelLabel.toLowerCase()} content available yet.</p>
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
                      <span className="flex-1 text-sm font-semibold">{panelLabel}</span>
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
                      statusLabel={prettyStatus(runStatus, gates, tasks, run, isV3)}
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
                          engineGateStageId={engineGate?.stageId ?? run?.activeGateStageId ?? null}
                          runPausedForGate={runPausedForGate}
                          metadataSummary={getAgentMetadataSummary(task, rawPrimaryNewsletter, run)}
                          canRerun={runStatus !== "executing_action" && runStatus !== "distributing" && task.status !== "in_progress" && task.status !== "todo"}
                          rerunning={busy === `rerun:${task.id}`}
                          onRerun={() => void rerunTask(task.id)}
                          onToggle={() => {
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

        <Dialog open={debugLogsOpen} onOpenChange={setDebugLogsOpen}>
          <DialogContent className="max-h-[86vh] gap-0 overflow-hidden p-0 sm:max-w-5xl">
            <DialogHeader className="border-b px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <DialogTitle>Run logs</DialogTitle>
                  <DialogDescription>
                    Raw run state, task inputs/outputs, events, gates, artifacts, and tool/LLM traces.
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void loadDebugLogs()}
                    disabled={debugLogsLoading}
                  >
                    <RefreshCw className={cn("size-3.5", debugLogsLoading && "animate-spin")} />
                    Refresh
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={!debugLogs}
                    onClick={() => navigator.clipboard?.writeText(JSON.stringify(debugLogs ?? {}, null, 2))}
                  >
                    <Copy className="size-3.5" />
                    Copy
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <ScrollArea className="h-[68vh] bg-slate-950">
              <pre className="min-w-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-slate-100">
                {debugLogsLoading && !debugLogs
                  ? "Loading run logs..."
                  : JSON.stringify(debugLogs ?? { message: "No logs loaded yet." }, null, 2)}
              </pre>
            </ScrollArea>
          </DialogContent>
        </Dialog>

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

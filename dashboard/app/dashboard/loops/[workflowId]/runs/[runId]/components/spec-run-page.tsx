"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { AnimatePresence, motion } from "motion/react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { CheckCircle2, FileText, Loader2, Workflow } from "lucide-react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
} from "@/components/ai-elements/interactive-prompt-menu";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  TranscriptMessageContent,
} from "@/components/ai-elements/transcript-message";
import { type ToolPart } from "@/components/ai-elements/tool";
import { dedupeChatMessagesById, mergeChatMessagesById } from "@/lib/chat-messages";
import { mergeSpecRunProjection } from "@/lib/spec-run-run-merge";
import {
  canKickSpecRunStream,
  hasSpecRunAutoStartAttempted,
  markSpecRunAutoStartAttempted,
  shouldContinueRunStream,
} from "@/lib/spec-run-stream-guard";
import type { OperatorView } from "@/lib/operator-view-types";
import { ArtifactRenderer } from "@/components/renderers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { InboundEmailTriggerCard } from "./inbound-email-trigger-card";
import { isCompactRunTool, RunToolRow } from "./run-tool-row";
import {
  hydrateMessagesFromSteps,
  isAgentTurnMessage,
  readAgentStepIndex,
  readMessageText,
  shouldAutoStartRunStream,
} from "./spec-run-transcript-hydration";
import { buildGatePromptOptions } from "@/lib/operator-view-types";
import {
  isArtifactSummaryNarration,
  resolveArtifactForStep,
  shouldShowStepOutputArtifact,
} from "@/lib/spec-run-step-artifacts";
import {
  formatAgentStructuredOutput,
  extractOutputFields,
  extractPriorOutputGroups,
  isNoActionReview,
  isRunMetaNarration,
  latestAttemptPerStep,
  resolveActiveGate,
  resolveDisplayArtifact,
  resolveHandoffTargets,
  resolveStepFailureMessage,
  toArtifactRecord,
  type HandoffFieldRow,
  type PriorOutputGroup,
  type SpecRunArtifact,
  type SpecRunInteraction,
  type SpecRunStep,
} from "./spec-run-view-utils";

type SpecRunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  error_json?: { message?: string };
  current_step_index?: number | null;
  spec?: Record<string, unknown>;
  definition?: {
    goal?: string;
    agentGraph?: {
      parent?: {
        name?: string;
        task?: string;
      };
      children?: Array<{
        id?: string;
        name?: string;
        task?: string;
        goal?: string;
        tools?: unknown[];
        persona?: {
          displayName: string;
          roleKey: string;
          roleLabel: string;
          avatarSeed: string;
          avatarUrl?: string;
        };
      }>;
    };
  };
  context?: Record<string, unknown>;
  steps: SpecRunStep[];
  interactions?: SpecRunInteraction[];
  artifacts?: SpecRunArtifact[];
  operatorView?: OperatorView | null;
};

const ACTIVE_STATUSES = new Set(["running", "queued", "waiting_for_interaction", "waiting_for_approval"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const GATE_TOOL_NAMES = ["requestReview", "requestApproval", "requestInput"];

type TriggerSummary = {
  event: string;
  subject: string;
  customerName: string;
  customerEmail: string;
  bodyPreview: string;
};

function parseTriggerSummary(text: string): TriggerSummary | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const event = trimmed.match(/^Event:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const subject = trimmed.match(/-\s*Subject:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const customerName = trimmed.match(/-\s*Name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const customerEmail = trimmed.match(/-\s*Email:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const rawBody = trimmed.match(/-\s*Body:\s*([\s\S]*?)(?:\n-\s*Thread ID:|\n\nCustomer|\nCustomer\s*\()/)?.[1]?.trim() ?? "";
  const bodyPreview = rawBody
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  if (!event && !subject && !customerEmail) return null;
  return { event, subject, customerName, customerEmail, bodyPreview };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readStepStructuredOutput(step: SpecRunStep | undefined, message: UIMessage): unknown {
  const stepData = step?.output_json?.data;
  if (stepData && "structuredOutput" in stepData) return stepData.structuredOutput;
  if (stepData && "data" in stepData) return stepData.data;

  for (const part of message.parts) {
    if (!isToolUIPart(part) || getToolName(part) !== "finalizeAgent") continue;
    if (part.state !== "input-available" && part.state !== "output-available") continue;
    const input = asRecord(part.input);
    if ("output" in input) return input.output;
  }

  return null;
}

function textFromOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  const record = asRecord(output);
  for (const key of ["body", "text", "content", "message", "summary", "html"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainTextEmailHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const body = paragraphs.length > 0
    ? paragraphs.map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br/>")}</p>`).join("")
    : "<p></p>";
  return `<html><body>${body}</body></html>`;
}

function buildRenderedStepArtifact(step: SpecRunStep | undefined, message: UIMessage): SpecRunArtifact | null {
  if (!step) return null;
  const outputContract = asRecord(step.agent_snapshot.outputContract);
  const renderer = typeof step.agent_snapshot.renderer === "string" && step.agent_snapshot.renderer.trim()
    ? step.agent_snapshot.renderer.trim()
    : typeof outputContract.renderer === "string" && outputContract.renderer.trim()
      ? outputContract.renderer.trim()
      : "";
  const visibility = typeof outputContract.visibility === "string" ? outputContract.visibility : "";
  if (!renderer && visibility !== "operator") return null;

  const structuredOutput = readStepStructuredOutput(step, message);
  if (!structuredOutput) return null;
  const record = asRecord(structuredOutput);
  const artifactKey = step.agent_snapshot.outputArtifactId ?? `${step.agent_id}_output`;
  const bodyText = textFromOutput(structuredOutput);
  const isEmailRenderer = renderer === "canvas.email" || renderer === "react.email" || renderer === "react-email";
  const isPreviewRenderer = renderer === "canvas.preview";

  if (isEmailRenderer || isPreviewRenderer) {
    const emailTemplate = asRecord(record.emailTemplate);
    const subject = typeof record.subject === "string" && record.subject.trim()
      ? record.subject.trim()
      : typeof emailTemplate.subject === "string" && emailTemplate.subject.trim()
        ? emailTemplate.subject.trim()
        : "Email draft";
    const html = typeof record.html === "string" && record.html.trim()
      ? record.html
      : typeof emailTemplate.html === "string" && emailTemplate.html.trim()
        ? emailTemplate.html
        : plainTextEmailHtml(bodyText);
    const text = typeof record.body === "string" && record.body.trim()
      ? record.body
      : typeof record.text === "string" && record.text.trim()
        ? record.text
        : typeof emailTemplate.text === "string" && emailTemplate.text.trim()
          ? emailTemplate.text
          : bodyText;
    return {
      id: `synthetic:${step.id}:${renderer}`,
      step_attempt_id: step.id,
      artifact_key: artifactKey,
      kind: isEmailRenderer ? "canvas_email" : "canvas_preview",
      body: html,
      data_json: {
        renderer,
        renderTarget: renderer,
        outputContract,
        structuredOutput,
        data: structuredOutput,
        ...(renderer === "canvas.preview" ? { canvas_state: "preview" } : {}),
        emailTemplate: {
          ...emailTemplate,
          html,
          text,
          subject,
          preview: typeof record.preview === "string" ? record.preview : subject,
          source: "spec-run",
        },
      },
      invalidated_at: null,
    };
  }

  return {
    id: `synthetic:${step.id}:${renderer || "operator"}`,
    step_attempt_id: step.id,
    artifact_key: artifactKey,
    kind: renderer || step.agent_snapshot.outputArtifactKind || "markdown",
    body: bodyText,
    data_json: {
      ...(renderer ? { renderer, renderTarget: renderer } : {}),
      outputContract,
      structuredOutput,
      data: structuredOutput,
    },
    invalidated_at: null,
  };
}

function shouldRenderAssistantText(text: string, options?: { hideArtifactSummary?: boolean }): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (parseJsonRecord(trimmed)) return false;
  if (/"emailDrafts"\s*:/.test(trimmed)) return false;
  if (/^re:\s*.+\n+hi\s+/i.test(trimmed)) return false;
  if (/best regards,\s*the support team/i.test(trimmed)) return false;
  if (/^priority classification:/i.test(trimmed)) return false;
  if (isRunMetaNarration(trimmed)) return false;
  if (options?.hideArtifactSummary && isArtifactSummaryNarration(trimmed)) return false;
  return true;
}

function isTriggerSeedMessage(message: UIMessage, index: number): boolean {
  if (index !== 0 || message.role !== "user") return false;
  return Boolean(parseTriggerSummary(readMessageText(message)));
}

function hasAgentPart(message: UIMessage): boolean {
  return message.parts.some((part) => part.type === "data-agent");
}

function hasVisibleText(message: UIMessage): boolean {
  return message.parts.some((part) => part.type === "text" && part.text.trim());
}

function isLooseTranscriptMessage(message: UIMessage, index: number): boolean {
  if (isTriggerSeedMessage(message, index)) return false;
  if (message.role === "user") return hasVisibleText(message);
  if (message.role !== "assistant") return false;
  if (hasAgentPart(message)) return false;
  return hasVisibleText(message);
}

function shouldRenderLiveStepText(ctx: {
  text: string;
  partIndex: number;
  parts: UIMessage["parts"];
  isLive: boolean;
}): boolean {
  if (!shouldRenderAssistantText(ctx.text)) return false;
  if (!ctx.isLive) return true;
  const trimmed = ctx.text.trim();
  if (trimmed.length >= 24) return true;
  const lastTextIdx = [...ctx.parts]
    .map((part, index) => (part.type === "text" && part.text.trim() ? index : -1))
    .filter((index) => index >= 0)
    .at(-1) ?? -1;
  return ctx.partIndex === lastTextIdx;
}

function ScrollOnStepComplete({ messages }: {
  messages: UIMessage[];
}) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  const completedToolIdsRef = useRef<Set<string>>(new Set());
  const lastAgentTurnCountRef = useRef(0);

  useEffect(() => {
    let shouldScroll = false;

    const agentTurnCount = messages.filter(isAgentTurnMessage).length;
    if (agentTurnCount !== lastAgentTurnCountRef.current) {
      lastAgentTurnCountRef.current = agentTurnCount;
      shouldScroll = true;
    }

    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available") continue;
        if (!("toolCallId" in part) || typeof part.toolCallId !== "string") continue;
        if (completedToolIdsRef.current.has(part.toolCallId)) continue;
        completedToolIdsRef.current.add(part.toolCallId);
        shouldScroll = true;
      }
    }

    if (shouldScroll && isAtBottom) {
      void scrollToBottom({
        animation: { damping: 0.8, stiffness: 0.04, mass: 1.5 },
        preserveScrollPosition: true,
      });
    }
  }, [messages, scrollToBottom, isAtBottom]);

  return null;
}

function TriggerCard({ summary }: { summary: TriggerSummary }) {
  return (
    <Message from="user" className="max-w-[760px]">
      <MessageContent className="w-full border-0 bg-transparent p-0 shadow-none">
        <InboundEmailTriggerCard summary={summary} />
      </MessageContent>
    </Message>
  );
}

function stepStatusLabel(status: string | undefined): string {
  if (!status) return "queued";
  return status.replace(/_/g, " ");
}

function StepStatusBadge({ status }: { status: string | undefined }) {
  const normalized = status ?? "queued";
  if (normalized === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#2563eb]">
        <Loader2 className="size-3 animate-spin" />
        running
      </span>
    );
  }
  if (normalized === "succeeded") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#16a34a]">
        <span className="size-2 rounded-full bg-[#16a34a]" aria-hidden />
        succeeded
      </span>
    );
  }
  if (normalized === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#dc2626]">
        <span className="size-2 rounded-full bg-[#dc2626]" aria-hidden />
        failed
      </span>
    );
  }
  if (normalized === "waiting_for_interaction" || normalized === "waiting_for_approval") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#d97706]">
        <span className="size-2 rounded-full bg-[#d97706]" aria-hidden />
        {stepStatusLabel(normalized)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[#6b7280]">
      <span className="size-2 rounded-full bg-[#d1d5db]" aria-hidden />
      {stepStatusLabel(normalized)}
    </span>
  );
}

function HandoffFieldList({ fields }: { fields: HandoffFieldRow[] }) {
  return (
    <div className="space-y-1.5">
      {fields.map((field) => (
        <div key={`${field.key}:${field.targetPath ?? ""}`} className="grid gap-1 sm:grid-cols-[120px_1fr] sm:items-start">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-[#374151]">{field.key}</span>
            {field.targetPath ? (
              <>
                <span className="text-[#9ca3af]">→</span>
                <span className="font-mono text-[11px] text-[#6b7280]">{field.targetPath}</span>
              </>
            ) : null}
          </div>
          <p className="text-[12px] leading-5 text-[#6b7280]">{field.preview}</p>
        </div>
      ))}
    </div>
  );
}

function HandoffInputGroup({ group }: { group: PriorOutputGroup }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#6b7280]">
        Received from {group.agentName}
      </p>
      <HandoffFieldList fields={group.fields} />
    </div>
  );
}

function HandoffInputPanel({ step }: { step: SpecRunStep | undefined }) {
  const groups = useMemo(() => extractPriorOutputGroups(step), [step]);
  const fieldCount = groups.reduce((total, group) => total + group.fields.length, 0);
  if (groups.length === 0) return null;

  const content = (
    <div className="space-y-4">
      {groups.map((group) => (
        <HandoffInputGroup key={`${group.agentId}:${group.agentName}`} group={group} />
      ))}
    </div>
  );

  if (fieldCount <= 4) {
    return (
      <div className="mt-3 rounded-md border border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 text-[12px]">
        {content}
      </div>
    );
  }

  return (
    <details className="group mt-3 rounded-md border border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 text-[12px]">
      <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.06em] text-[#6b7280] marker:content-none [&::-webkit-details-marker]:hidden">
        Received handoff ({fieldCount} fields)
      </summary>
      <div className="mt-3">{content}</div>
    </details>
  );
}

function HandoffOutputPanel({
  step,
  allSteps,
}: {
  step: SpecRunStep | undefined;
  allSteps: SpecRunStep[];
}) {
  const fields = useMemo(() => extractOutputFields(step), [step]);
  const targets = useMemo(() => resolveHandoffTargets(step, allSteps), [allSteps, step]);
  if (fields.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 text-[12px]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#6b7280]">Produced</p>
      <div className="mt-2">
        <HandoffFieldList fields={fields} />
      </div>
      {targets.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-[#e5e7eb] pt-3">
          {targets.map((target) => (
            <p key={target.agentName} className="text-[11px] text-[#9ca3af]">
              → feeds into {target.agentName}
              {target.fields.length > 0 ? ` (${target.fields.join(", ")})` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FinalizeAgentOutput({ part }: { part: ToolPart }) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  const text = formatAgentStructuredOutput(input.output);
  if (!text) return null;
  return (
    <div className="mt-1">
      <MessageResponse>{text}</MessageResponse>
    </div>
  );
}

function CompletedGateSummary({ toolName, part }: { toolName: string; part: ToolPart }) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  const output = part.output && typeof part.output === "object" && !Array.isArray(part.output)
    ? part.output as Record<string, unknown>
    : {};
  const connectorOutput = output.output && typeof output.output === "object" && !Array.isArray(output.output)
    ? output.output as Record<string, unknown>
    : null;
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  const connectorMessage = connectorOutput
    ? typeof connectorOutput.message === "string"
      ? connectorOutput.message
      : typeof connectorOutput.id === "string"
        ? `Connector action completed. ID: ${connectorOutput.id}`
        : "Connector action completed successfully."
    : "";
  const label = toolName === "requestApproval" && output.ok === true && connectorOutput
    ? "Connector action completed"
    : toolName === "requestReview"
    ? "Draft review completed"
    : toolName === "requestApproval"
      ? "Approval completed"
      : "Input received";

  return (
    <div className="rounded-md border border-[#e5e7eb] bg-[#fafafa] px-4 py-3 text-[13px] text-[#374151]">
      <div className="flex items-center gap-2 font-medium text-[#111827]">
        <CheckCircle2 className="size-4 text-[#16a34a]" />
        {label}
      </div>
      {connectorMessage ? <p className="mt-1.5 leading-5 text-[#6b7280]">{connectorMessage}</p> : null}
      {rationale ? <p className="mt-1.5 leading-5 text-[#6b7280]">{rationale}</p> : null}
    </div>
  );
}

function mapGateAnswer(answer: InteractivePromptAnswer) {
  const optionId = answer.selectedOptionIds[0];
  if (optionId === "approve") {
    return {
      command: "approve" as const,
      value: { channel: "dashboard", approvalIntent: "approve_and_send" },
    };
  }
  if (optionId === "reject") return { command: "reject" as const, value: { reason: "Rejected by operator" } };
  if (optionId === "revise") {
    const feedback = answer.otherText?.trim() || answer.answerText || "Operator requested changes.";
    return { command: "revise" as const, value: { feedback, channel: "dashboard" } };
  }
  return { command: "submit_input" as const, value: { channel: "dashboard", text: answer.answerText } };
}

type GateCommand = ReturnType<typeof mapGateAnswer>;

function optimisticInteractionStatus(command: GateCommand["command"]): SpecRunInteraction["status"] {
  if (command === "approve") return "approved";
  if (command === "submit_input") return "submitted";
  return "rejected";
}

function optimisticDecision(mapped: GateCommand): Record<string, unknown> {
  if (mapped.command === "submit_input") return { input: mapped.value, channel: mapped.value.channel };
  if (mapped.command === "revise") {
    const raw = typeof mapped.value.feedback === "string" ? mapped.value.feedback : "Operator requested changes.";
    return {
      command: "revise",
      reason: raw.replace(/^requested\s+changes:\s*/i, "").replace(/^revise(d)?\s*/i, "").trim() || raw,
      channel: mapped.value.channel,
    };
  }
  if (mapped.command === "reject") {
    return {
      command: "reject",
      reason: typeof mapped.value.reason === "string" ? mapped.value.reason : "Rejected by operator",
    };
  }
  return { output: { ok: true, approved: true, value: mapped.value }, channel: mapped.value.channel };
}

function toolRefLabel(tool: unknown): string {
  if (typeof tool === "string") return tool;
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const record = tool as Record<string, unknown>;
    if (typeof record.ref === "string") return record.ref;
    if (typeof record.name === "string") return record.name;
  }
  return "";
}

function SpecRunDetailsDialog({
  open,
  onOpenChange,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: SpecRunProjection;
}) {
  const flow = latestAttemptPerStep(run.steps);
  const specJson = JSON.stringify({
    spec: run.spec ?? null,
    definition: run.definition ?? null,
    context: run.context ?? null,
  }, null, 2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden rounded-lg border border-[#d1d5db] bg-white p-0 text-[#111827] sm:!max-w-[1040px]"
      >
        <DialogHeader className="border-b border-[#e5e7eb] px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-[16px] font-semibold">
            <FileText className="size-4" />
            Run spec
          </DialogTitle>
          <DialogDescription className="text-[13px] text-[#6b7280]">
            Referenced spec snapshot and the agent flow materialized for this run.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[360px_1fr]">
          <section className="min-h-0 overflow-y-auto border-b border-[#e5e7eb] p-5 md:border-b-0 md:border-r">
            <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#6b7280]">
              <Workflow className="size-4" />
              Runner flow
            </div>
            <div className="space-y-3">
              {flow.map((step) => {
                const tools = Array.isArray(step.agent_snapshot.tools)
                  ? step.agent_snapshot.tools.map(toolRefLabel).filter(Boolean)
                  : [];
                const renderer = typeof step.agent_snapshot.renderer === "string"
                  ? step.agent_snapshot.renderer
                  : typeof step.agent_snapshot.outputContract?.renderer === "string"
                    ? step.agent_snapshot.outputContract.renderer
                    : "";
                const gate = step.agent_snapshot.gate && Object.keys(step.agent_snapshot.gate).length > 0
                  ? step.agent_snapshot.gate
                  : null;
                return (
                  <div key={`${step.id}-${step.attempt}`} className="border border-[#d1d5db] bg-[#fafafa] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-semibold text-[#111827]">
                          {step.agent_snapshot.name || step.agent_id}
                        </p>
                        <p className="text-[12px] text-[#6b7280]">Agent {step.step_index + 1} · attempt {step.attempt}</p>
                      </div>
                      {step.status === "running" ? null : (
                        <span className="shrink-0 border border-[#d1d5db] bg-white px-2 py-1 text-[11px] font-medium uppercase text-[#4b5563]">
                          {step.status}
                        </span>
                      )}
                    </div>
                    {step.agent_snapshot.task ? (
                      <p className="mt-2 text-[13px] leading-5 text-[#374151]">{step.agent_snapshot.task}</p>
                    ) : null}
                    <div className="mt-3 grid gap-2 text-[12px] text-[#4b5563]">
                      {renderer ? <p>Renderer: <span className="font-medium text-[#111827]">{renderer}</span></p> : null}
                      {step.agent_snapshot.artifactRole ? (
                        <p>Artifact role: <span className="font-medium text-[#111827]">{step.agent_snapshot.artifactRole}</span></p>
                      ) : null}
                      {gate ? (
                        <p>Gate: <span className="font-medium text-[#111827]">{String(gate.type ?? "configured")}</span></p>
                      ) : null}
                      {Array.isArray(step.agent_snapshot.handoffBindings) && step.agent_snapshot.handoffBindings.length > 0 ? (
                        <p>{step.agent_snapshot.handoffBindings.length} handoff binding{step.agent_snapshot.handoffBindings.length === 1 ? "" : "s"}</p>
                      ) : null}
                    </div>
                    {tools.length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {tools.map((tool) => (
                          <span key={tool} className="border border-[#d1d5db] bg-white px-2 py-1 text-[11px] text-[#4b5563]">
                            {tool}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {flow.length === 0 ? (
                <p className="text-[13px] text-[#6b7280]">No runner steps have been materialized yet.</p>
              ) : null}
            </div>
          </section>

          <section className="min-h-0 overflow-hidden p-5">
            <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#6b7280]">
              Referenced spec
            </div>
            <pre className="h-full min-h-[360px] overflow-auto border border-[#d1d5db] bg-[#0f172a] p-4 text-[12px] leading-5 text-[#e5e7eb]">
              {specJson}
            </pre>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SpecRunPage({
  workflowId,
  runId,
  run: initialRun,
  onRefresh: _onRefresh,
}: {
  workflowId: string;
  runId: string;
  run: SpecRunProjection;
  onRefresh: () => Promise<void>;
}) {
  const [run, setRun] = useState(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedAnswer, setSubmittedAnswer] = useState<InteractivePromptAnswer | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const canvasFlushRef = useRef<(() => Promise<void>) | null>(null);
  const continueInFlightRef = useRef(false);
  const chatStatusRef = useRef("ready");

  useEffect(() => {
    setRun((prev) => mergeSpecRunProjection(prev, initialRun));
  }, [initialRun]);

  const refreshRun = useCallback(async () => {
    const response = await fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.run) {
      setRun((prev) => mergeSpecRunProjection(prev, payload.run as SpecRunProjection));
    }
  }, [runId]);

  const { messages, sendMessage, setMessages, status: chatStatus, stop } = useChat({
    id: runId,
    transport: new DefaultChatTransport({
      api: `/api/workflows/loops/${workflowId}/run/chat`,
      prepareSendMessagesRequest: async ({ messages: chatMessages, id }) => {
        const response = await fetch(`/api/workflows/runs/${id}/messages`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        const serverMessages = Array.isArray(payload.messages)
          ? dedupeChatMessagesById(payload.messages as UIMessage[])
          : dedupeChatMessagesById(chatMessages);
        const serverIds = new Set(serverMessages.map((message) => message.id));
        const trailingClient = chatMessages.filter((message) => !serverIds.has(message.id));
        return {
          body: {
            runId: id,
            messages: dedupeChatMessagesById([...serverMessages, ...trailingClient]),
          },
        };
      },
    }),
    onFinish: () => {
      void refreshRun();
      window.setTimeout(() => {
        void refreshMessages(true);
      }, 400);
    },
    onError: (chatError) => {
      continueInFlightRef.current = false;
      setError(chatError.message || "Run stream failed");
      window.setTimeout(() => {
        void refreshRun();
        void refreshMessages(true);
      }, 400);
    },
  });

  useEffect(() => {
    chatStatusRef.current = chatStatus;
    if (chatStatus === "ready") {
      continueInFlightRef.current = false;
    }
  }, [chatStatus]);

  const refreshMessages = useCallback(async (force = false) => {
    if (!force && !canKickSpecRunStream(chatStatus)) return;
    const response = await fetch(`/api/workflows/runs/${runId}/messages`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(payload.messages)) {
      setMessages((prev) => mergeChatMessagesById(
        dedupeChatMessagesById(payload.messages as UIMessage[]),
        prev,
      ));
    }
  }, [chatStatus, runId, setMessages]);

  const isChatActive = chatStatus === "streaming" || chatStatus === "submitted";

  const kickRunStream = useCallback(async () => {
    if (!canKickSpecRunStream(chatStatusRef.current) || continueInFlightRef.current) return false;
    continueInFlightRef.current = true;
    try {
      await sendMessage({ text: "Continue" });
      return true;
    } catch {
      continueInFlightRef.current = false;
      return false;
    }
  }, [sendMessage]);

  const resumeRunStreamWithRetry = useCallback(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (canKickSpecRunStream(chatStatusRef.current)) {
        return kickRunStream();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return false;
  }, [kickRunStream]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/workflows/runs/${runId}/messages`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!cancelled && response.ok && Array.isArray(payload.messages)) {
        setMessages(dedupeChatMessagesById(payload.messages as UIMessage[]));
      }
    })();
    return () => { cancelled = true; };
  }, [runId, setMessages]);

  const post = useCallback(async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      if (payload.run) {
        setRun((prev) => mergeSpecRunProjection(prev, payload.run as SpecRunProjection));
      }
      await refreshRun();
      await refreshMessages();
      return payload;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [refreshMessages, refreshRun]);

  const continueRunStream = useCallback(async () => {
    const resumed = await resumeRunStreamWithRetry();
    if (!resumed) {
      setError("Could not resume the run. Send Continue to try again.");
    }
  }, [resumeRunStreamWithRetry]);

  const pendingInteraction = useMemo(
    () => run.interactions?.find((interaction) => interaction.status === "pending") ?? null,
    [run.interactions],
  );

  const gate = useMemo(
    () => resolveActiveGate({
      runStatus: run.status,
      steps: run.steps,
      pendingInteraction,
      operatorView: run.operatorView ?? null,
    }),
    [pendingInteraction, run.operatorView, run.status, run.steps],
  );

  const transcriptMessages = useMemo(
    () => hydrateMessagesFromSteps(
      dedupeChatMessagesById(messages),
      run.steps,
      run.interactions ?? [],
    ),
    [messages, run.interactions, run.steps],
  );

  const liveAgentMessageId = useMemo(() => {
    if (!isChatActive) return null;
    const turns = transcriptMessages.filter(isAgentTurnMessage);
    return turns.at(-1)?.id ?? null;
  }, [isChatActive, transcriptMessages]);

  const stepByIndex = useMemo(
    () => new Map(latestAttemptPerStep(run.steps).map((step) => [step.step_index, step])),
    [run.steps],
  );

  const totalAgents = run.definition?.agentGraph?.children?.length ?? 0;

  useEffect(() => {
    if (hasSpecRunAutoStartAttempted(runId)) return;
    if (!shouldAutoStartRunStream({
      runStatus: run.status,
      messages,
      pendingInteraction: Boolean(pendingInteraction),
      chatStatus,
    })) {
      return;
    }
    markSpecRunAutoStartAttempted(runId);
    void kickRunStream();
  }, [chatStatus, kickRunStream, messages, pendingInteraction, run.status, runId]);

  useEffect(() => {
    if (!shouldContinueRunStream({
      runStatus: run.status,
      steps: run.steps,
      pendingInteraction: Boolean(pendingInteraction),
      chatStatus,
      totalAgents,
    })) {
      return;
    }
    void kickRunStream();
  }, [chatStatus, kickRunStream, pendingInteraction, run.status, run.steps, totalAgents]);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(run.status) || isChatActive) return;
    const interval = window.setInterval(() => {
      void refreshRun();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [isChatActive, refreshRun, run.status]);

  const displayArtifact = useMemo(
    () => resolveDisplayArtifact({
      artifacts: run.artifacts,
      operatorView: gate.operatorView,
      pendingInteraction,
    }),
    [gate.operatorView, pendingInteraction, run.artifacts],
  );

  const canvasArtifact = displayArtifact;
  const gateArtifactForStep = displayArtifact;
  const noActionReview = isNoActionReview({
    operatorView: gate.operatorView,
    pendingInteraction,
    displayArtifact,
  });

  const submitInteractionCommand = useCallback(async (
    interactionId: string,
    mapped: GateCommand,
    options?: { submittedAnswer?: InteractivePromptAnswer | null; flushCanvas?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (options?.flushCanvas && mapped.command === "approve" && canvasArtifact && canvasFlushRef.current) {
        try {
          await canvasFlushRef.current();
        } catch {
          // Proceed even if draft save fails.
        }
      }
      const response = await fetch(
        `/api/workflows/runs/${runId}/interactions/${interactionId}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mapped),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to submit review decision");

      setRun((prev) => {
        const optimistic: SpecRunProjection = {
          ...prev,
          status: "running",
          interactions: (prev.interactions ?? []).map((entry) =>
            entry.id === interactionId
              ? {
                ...entry,
                status: optimisticInteractionStatus(mapped.command),
                decision_json: optimisticDecision(mapped),
              }
              : entry
          ),
        };
        return payload.run
          ? mergeSpecRunProjection(optimistic, payload.run as SpecRunProjection)
          : optimistic;
      });
      if (options?.submittedAnswer !== undefined) {
        setSubmittedAnswer(options.submittedAnswer);
      }

      if (payload.resumeViaStream !== false) {
        const resumed = await resumeRunStreamWithRetry();
        if (!resumed) {
          setError("Your decision was saved, but the run did not resume. Send Continue to retry.");
        }
      } else {
        await refreshRun();
      }
      if (payload.resumeViaStream !== false) {
        void refreshMessages(true);
      }
    } catch (requestError) {
      if (options?.submittedAnswer !== undefined) {
        setSubmittedAnswer(null);
      }
      setError(requestError instanceof Error ? requestError.message : "Failed to submit review decision");
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [canvasArtifact, refreshMessages, refreshRun, resumeRunStreamWithRetry, runId]);

  useEffect(() => {
    if (!gate.show) setSubmittedAnswer(null);
  }, [gate.show, gate.interaction?.id]);

  const renderRunTool = useCallback((part: ToolPart, toolName: string, index: number): ReactNode | null | undefined => {
    if (isCompactRunTool(toolName)) {
      if (
        part.state === "output-available"
        || part.state === "output-error"
      ) {
        return <RunToolRow key={index} part={part} toolName={toolName} />;
      }
      return null;
    }
    if (toolName === "finalizeAgent") {
      if (part.state === "input-streaming" || part.state === "input-available") return null;
      if (part.state === "output-available") {
        return <FinalizeAgentOutput key={index} part={part} />;
      }
    }
    if (GATE_TOOL_NAMES.includes(toolName)) {
      // Hide while streaming input — gate composer handles the active state.
      if (part.state === "input-streaming" || part.state === "input-available") return null;
      if (part.state === "output-error") return null;
      const errorText = (part as { errorText?: string }).errorText;
      if (errorText) return null;
      if (part.state === "output-available") {
        return <CompletedGateSummary key={index} part={part} toolName={toolName} />;
      }
      return null;
    }
    return undefined;
  }, []);

  async function handleGateSubmit(answer: InteractivePromptAnswer) {
    if (!gate.interaction) return;
    await submitInteractionCommand(
      gate.interaction.id,
      mapGateAnswer(answer),
      { submittedAnswer: answer, flushCanvas: true },
    );
  }

  async function saveCanvasEmail(
    artifactKey: string,
    value: { design: unknown; html: string; text?: string; subject?: string; preview?: string },
  ) {
    await post(
      `/api/workflows/runs/${runId}/artifacts/${encodeURIComponent(artifactKey)}/canvas/email`,
      value as Record<string, unknown>,
    );
  }

  async function submitComposerText(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    const normalized = value.toLowerCase();
    if (pendingInteraction) {
      let mapped: GateCommand;
      if (/^(approve|approved|yes|send|approve and send)$/i.test(value)) {
        mapped = {
          command: "approve",
          value: { channel: "dashboard", approvalIntent: "approve_and_send" },
        };
      } else if (/^(reject|cancel|stop)$/i.test(value)) {
        mapped = { command: "reject", value: { reason: "Rejected by operator" } };
      } else if (gate.operatorView?.actions.some((action) => action.command === "submit_input")) {
        mapped = {
          command: "submit_input",
          value: { channel: "dashboard", text: value },
        };
      } else {
        mapped = {
          command: "revise",
          value: { channel: "dashboard", feedback: value },
        };
      }
      await submitInteractionCommand(pendingInteraction.id, mapped);
      return;
    }
    if (chatStatus === "streaming" || chatStatus === "submitted") {
      setError("Wait for the current step to finish.");
      return;
    }
    if (ACTIVE_STATUSES.has(run.status)) {
      if (/^(retry|rerun)$/i.test(normalized) && (run.status === "failed" || run.status === "cancelled")) {
        await post(`/api/workflows/runs/${runId}/retry`);
      }
      await continueRunStream();
      return;
    }
    if (/^(continue|resume)$/i.test(normalized)) {
      await continueRunStream();
      return;
    }
    await sendMessage({ text: value });
  }

  const gateTitle = gate.operatorView?.workspace.title ?? pendingInteraction?.question ?? "Review required";
  const gateSubtitle = gate.operatorView?.workspace.subtitle ?? pendingInteraction?.question ?? gateTitle;
  const showGateComposer = Boolean(gate.show && gate.operatorView && !submittedAnswer && !noActionReview);
  const showGateLoading = gate.show && !submittedAnswer && !gate.operatorView && !noActionReview;
  const composerPlaceholder = pendingInteraction
    ? "Respond to the pending review…"
    : "Message the loop runner…";

  return (
    <main className="relative flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-white text-[#111827]">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[400px] bg-gradient-to-t from-slate-100 to-transparent" />
      <div className="relative z-10 flex h-full flex-col overflow-hidden">
        <div className="absolute right-4 top-4 z-30">
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="inline-flex items-center gap-2 border border-[#d1d5db] bg-white px-3 py-2 text-[13px] font-medium text-[#374151] shadow-sm transition-colors hover:bg-[#f9fafb]"
          >
            <FileText className="size-4" />
            View spec
          </button>
        </div>
        <SpecRunDetailsDialog open={detailsOpen} onOpenChange={setDetailsOpen} run={run} />
        <Conversation resize={isChatActive ? "instant" : "smooth"}>
          <ConversationContent className={`mx-auto max-w-3xl gap-6 px-4 pb-40 pt-16 ${showGateComposer ? "pb-[560px]" : "pb-40"}`}>
            <ScrollOnStepComplete messages={transcriptMessages} />

            {transcriptMessages.map((message, index) => {
              if (isTriggerSeedMessage(message, index)) {
                const summary = parseTriggerSummary(readMessageText(message));
                if (summary) return <TriggerCard key={message.id} summary={summary} />;
              }

              if (isAgentTurnMessage(message)) {
                const stepIndex = readAgentStepIndex(message);
                const step = stepIndex !== null ? stepByIndex.get(stepIndex) : undefined;
                const isLive = message.id === liveAgentMessageId;
                const persistedStepArtifact = resolveArtifactForStep({
                  artifacts: run.artifacts,
                  stepAttemptId: step?.id,
                  gateArtifact: gateArtifactForStep,
                });
                const syntheticStepArtifact = persistedStepArtifact ? null : buildRenderedStepArtifact(step, message);
                const stepArtifact = persistedStepArtifact ?? syntheticStepArtifact;
                const pendingForStep = run.interactions?.find((interaction) =>
                  interaction.step_attempt_id === step?.id
                  && interaction.status === "pending"
                ) ?? null;
                const showArtifact = Boolean(
                  stepArtifact
                  && (shouldShowStepOutputArtifact(step) || pendingForStep)
                  && !noActionReview
                );
                const hideArtifactSummary = showArtifact;
                const nextAgentName = stepIndex !== null
                  ? run.definition?.agentGraph?.children?.[stepIndex + 1]?.name
                  : undefined;
                const failureMessage = resolveStepFailureMessage(
                  step,
                  error ?? run.error_json?.message,
                );

                return (
                  <div key={message.id} className="flex w-full flex-col gap-2">
                    <Message from="assistant">
                      <MessageContent className="w-full">
                        <TranscriptMessageContent
                          message={message}
                          renderTool={renderRunTool}
                          isStreaming={isLive}
                          transcriptVariant="run"
                          shouldRenderText={({ text, partIndex, parts }) => {
                            if (showArtifact) return false;
                            if (!shouldRenderAssistantText(text, { hideArtifactSummary })) return false;
                            return shouldRenderLiveStepText({
                              text,
                              partIndex,
                              parts,
                              isLive,
                            });
                          }}
                        />
                      </MessageContent>
                    </Message>

                    {failureMessage ? (
                      <p className="text-[13px] leading-5 text-[#6b7280]">
                        <span className="font-medium text-[#374151]">Error: </span>
                        {failureMessage}
                      </p>
                    ) : null}

                    {showArtifact && stepArtifact ? (
                      <Message from="assistant" className="max-w-none">
                        <MessageContent className="w-full max-w-none border-0 bg-transparent p-0 shadow-none">
                          <ArtifactRenderer
                            artifact={toArtifactRecord(stepArtifact)}
                            flushRef={
                              gateArtifactForStep?.id === stepArtifact.id
                                ? canvasFlushRef
                                : undefined
                            }
                            runId={runId}
                            saving={busy}
                            onSave={async (data) => {
                              if (stepArtifact.id.startsWith("synthetic:")) return;
                              await saveCanvasEmail(stepArtifact.artifact_key, data as {
                                design: unknown;
                                html: string;
                                text?: string;
                                subject?: string;
                                preview?: string;
                              });
                            }}
                          />
                        </MessageContent>
                      </Message>
                    ) : null}

                    {step?.status === "succeeded" && nextAgentName ? (
                      <p className="text-[12px] font-medium text-[#7eb71b]">
                        Then → {nextAgentName}
                      </p>
                    ) : null}
                  </div>
                );
              }

              if (isLooseTranscriptMessage(message, index)) {
                return (
                  <Message key={message.id} from={message.role === "user" ? "user" : "assistant"}>
                    <MessageContent className="w-full">
                      <TranscriptMessageContent
                        message={message}
                        renderTool={renderRunTool}
                        shouldRenderText={message.role === "assistant"
                          ? ({ text }) => shouldRenderAssistantText(text)
                          : undefined}
                      />
                    </MessageContent>
                  </Message>
                );
              }

              return null;
            })}

          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto w-full max-w-3xl px-4 pb-4">
          <AnimatePresence mode="wait" initial={false}>
            {showGateComposer ? (
              <motion.div
                key={`gate-${gate.interaction?.id}`}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                initial={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto space-y-2 border border-[#d1d5db] bg-white"
              >
                {showGateLoading ? (
                  <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-[#6b7280]">
                    <Loader2 className="size-4 animate-spin" />
                    {gateTitle}
                  </div>
                ) : (
                  <>
                    <p className="px-4 pt-3 text-[12px] leading-5 text-[#6b7280]">{gateSubtitle}</p>
                    <InteractivePromptMenu
                      allowMultiple={false}
                      allowOther
                      disabled={busy}
                      onSubmit={(answer) => { void handleGateSubmit(answer); }}
                      options={buildGatePromptOptions(gate.operatorView!)}
                      placement="composer"
                      question={gateSubtitle}
                      recommendedOptionIds={["approve"]}
                      submittedAnswer={submittedAnswer ?? undefined}
                    />
                  </>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="prompt-input"
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto relative overflow-hidden border border-[#d1d5db] bg-white transition-colors focus-within:border-[#9ca3af]"
              >
                <PromptInput
                  className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0"
                  onSubmit={({ text }) => { void submitComposerText(text); }}
                >
                  <PromptInputTextarea
                    className="min-h-0 pr-12 pb-2"
                    disabled={busy || chatStatus === "streaming" || chatStatus === "submitted"}
                    placeholder={composerPlaceholder}
                  />
                  <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                    <PromptInputSubmit
                      className="bg-[#111827] text-white hover:opacity-85"
                      onStop={stop}
                      status={chatStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center justify-center gap-1 pb-4 text-center text-[11px] text-[#999]">
          <p>Tallei can make mistakes. Check important info.</p>
        </div>
      </div>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
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
  findActiveToolPart,
  TranscriptMessageContent,
} from "@/components/ai-elements/transcript-message";
import { type ToolPart } from "@/components/ai-elements/tool";
import { dedupeChatMessagesById } from "@/lib/chat-messages";
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
import {
  buildSequentialStepTranscript,
  hydrateMessagesFromSteps,
  readMessageText,
  shouldAutoStartRunStream,
} from "./spec-run-transcript-hydration";
import {
  buildGatePromptOptions,
  formatAgentStructuredOutput,
  latestAttemptPerStep,
  resolveActiveGate,
  resolveDisplayArtifact,
  toArtifactRecord,
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
        tools?: unknown[];
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

function shouldRenderAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (parseJsonRecord(trimmed)) return false;
  if (/"emailDrafts"\s*:/.test(trimmed)) return false;
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

function ScrollOnUpdate() {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  useEffect(() => {
    if (!isAtBottom) return;
    void scrollToBottom({ animation: { damping: 0.85, stiffness: 0.05, mass: 1.2 } });
  }, [isAtBottom, scrollToBottom]);
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

function SearchToolSummary({ part, toolName }: { part: ToolPart; toolName: string }) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  const output = part.output && typeof part.output === "object" && !Array.isArray(part.output)
    ? part.output as Record<string, unknown>
    : {};
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const sources = Array.isArray(output.sources) ? output.sources : [];
  const reused = output.reused === true;
  const label = toolName === "searchWeb" ? "Web search" : "Memory search";
  const sourceLabel = sources.length === 1 ? "1 source" : `${sources.length} sources`;

  return (
    <div className="rounded-md border border-[#e5e7eb] bg-[#fafafa] px-4 py-3 text-[13px] text-[#374151]">
      <div className="flex flex-wrap items-center gap-2 font-medium text-[#111827]">
        <CheckCircle2 className="size-4 text-[#16a34a]" />
        <span>{label} completed</span>
        <span className="text-[#6b7280]">· {reused ? "reused" : sourceLabel}</span>
      </div>
      {query ? <p className="mt-1.5 leading-5 text-[#6b7280]">{query}</p> : null}
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
    return {
      command: "revise",
      reason: typeof mapped.value.feedback === "string" ? mapped.value.feedback : "Operator requested changes.",
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
                      <span className="shrink-0 border border-[#d1d5db] bg-white px-2 py-1 text-[11px] font-medium uppercase text-[#4b5563]">
                        {step.status}
                      </span>
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
  onRefresh,
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
  const autoStartAttemptedRef = useRef(false);

  useEffect(() => {
    setRun(initialRun);
  }, [initialRun]);

  const refreshRun = useCallback(async () => {
    const response = await fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.run) setRun(payload.run as SpecRunProjection);
    await onRefresh();
  }, [onRefresh, runId]);

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
      // Refresh run state + reload messages from server (server dedupes by step index on save).
      void refreshRun();
      void refreshMessages();
    },
  });

  const refreshMessages = useCallback(async () => {
    const response = await fetch(`/api/workflows/runs/${runId}/messages`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(payload.messages)) {
      setMessages(dedupeChatMessagesById(payload.messages as UIMessage[]));
    }
  }, [runId, setMessages]);

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

  useEffect(() => {
    // Only poll while the run is live or a stream is in flight.
    if (!ACTIVE_STATUSES.has(run.status) && chatStatus !== "streaming" && chatStatus !== "submitted") return;
    // Don't poll during streaming — refreshMessages during streaming can overwrite in-flight
    // messages and cause visual flicker.  onFinish does the authoritative reload.
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    const timer = window.setInterval(() => {
      void (async () => {
        await refreshRun();
        await refreshMessages();
      })();
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [run.status, chatStatus, refreshMessages, refreshRun]);

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
      if (payload.run) setRun(payload.run as SpecRunProjection);
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
    await sendMessage({ text: "Continue" });
  }, [sendMessage]);

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

  const activeGateTool = useMemo(
    () => findActiveToolPart(messages, GATE_TOOL_NAMES),
    [messages],
  );

  const transcriptMessages = useMemo(
    () => hydrateMessagesFromSteps(
      dedupeChatMessagesById(messages),
      run.steps,
      run.interactions ?? [],
    ),
    [messages, run.interactions, run.steps],
  );
  const looseTranscriptMessages = useMemo(
    () => transcriptMessages.filter(isLooseTranscriptMessage),
    [transcriptMessages],
  );

  useEffect(() => {
    autoStartAttemptedRef.current = false;
  }, [runId]);

  useEffect(() => {
    if (autoStartAttemptedRef.current) return;
    if (!shouldAutoStartRunStream({
      runStatus: run.status,
      messages,
      pendingInteraction: Boolean(pendingInteraction),
      chatStatus,
    })) {
      return;
    }
    autoStartAttemptedRef.current = true;
    void sendMessage({ text: "Continue" });
  }, [chatStatus, messages, pendingInteraction, run.status, sendMessage]);

  const displayArtifact = useMemo(
    () => resolveDisplayArtifact({
      artifacts: run.artifacts,
      operatorView: gate.operatorView,
      pendingInteraction,
    }),
    [gate.operatorView, pendingInteraction, run.artifacts],
  );

  const canvasArtifact = displayArtifact;
  const artifactStepAttemptId = displayArtifact?.step_attempt_id ?? pendingInteraction?.step_attempt_id ?? null;

  const stepTranscript = useMemo(
    () => buildSequentialStepTranscript({
      steps: run.steps,
      messages,
      interactions: run.interactions ?? [],
      chatStatus,
      pendingInteractionStepAttemptId: artifactStepAttemptId,
    }),
    [artifactStepAttemptId, chatStatus, messages, run.interactions, run.steps],
  );

  useEffect(() => {
    if (!gate.show) setSubmittedAnswer(null);
  }, [gate.show, gate.interaction?.id]);

  // Show the working indicator only in the pre-stream gap (run is active but no tokens yet).
  // Don't show it while streaming — real content is already visible then.
  const showWorking = !gate.show
    && !activeGateTool
    && chatStatus !== "streaming"
    && (run.status === "running" || chatStatus === "submitted");

  const renderRunTool = useCallback((part: ToolPart, toolName: string, index: number): ReactNode | null | undefined => {
    if (toolName === "searchMemory" || toolName === "searchWeb") {
      if (part.state === "input-streaming" || part.state === "input-available") return null;
      if (part.state === "output-available") return <SearchToolSummary key={index} part={part} toolName={toolName} />;
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
      const errorText = (part as { errorText?: string }).errorText;
      if (errorText || part.state === "output-error") {
        return (
          <div key={index} className="rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[12px] text-[#991b1b]">
            {errorText || "Connector action failed."}
          </div>
        );
      }
      if (part.state === "output-available") {
        // If the tool result carries an error (e.g. validation failure), show a compact
        // red pill instead of the raw CollapsibleTool JSON dump.
        return <CompletedGateSummary key={index} part={part} toolName={toolName} />;
      }
      // Any other state (e.g. error state from AI SDK) — suppress rather than show raw JSON.
      return null;
    }
    return undefined;
  }, []);

  async function handleGateSubmit(answer: InteractivePromptAnswer) {
    if (!gate.interaction) return;
    const mapped = mapGateAnswer(answer);
    const interactionId = gate.interaction.id;
    setBusy(true);
    setError(null);
    try {
      if (mapped.command === "approve" && canvasArtifact && canvasFlushRef.current) {
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

      // Optimistically resolve the gate — don't wait for refreshRun to dismiss it.
      setRun((prev) => ({
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
      }));
      setSubmittedAnswer(answer);
      setBusy(false);

      // Kick off the stream immediately. onFinish will refresh run/messages.
      if (payload.resumeViaStream !== false) {
        void sendMessage({ text: "Continue" });
      } else {
        // Headless path — refresh to pick up completed state.
        void refreshRun();
      }
    } catch (requestError) {
      setSubmittedAnswer(null);
      setError(requestError instanceof Error ? requestError.message : "Failed to submit review decision");
      setBusy(false);
    }
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
          value: { channel: "dashboard", approvalIntent: "approve_and_send", text: value },
        };
      } else if (/^(reject|cancel|stop)$/i.test(value)) {
        mapped = {
          command: "reject",
          value: { channel: "dashboard", reason: "Rejected by operator" },
        };
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
      await post(`/api/workflows/runs/${runId}/interactions/${pendingInteraction.id}/commands`, mapped);
      setRun((prev) => ({
        ...prev,
        status: "running",
        interactions: (prev.interactions ?? []).map((entry) =>
          entry.id === pendingInteraction.id
            ? {
              ...entry,
              status: optimisticInteractionStatus(mapped.command),
              decision_json: optimisticDecision(mapped),
            }
            : entry
        ),
      }));
      await continueRunStream();
      return;
    }
    if (/^(continue|resume|retry|run|rerun)$/i.test(normalized) && !ACTIVE_STATUSES.has(run.status)) {
      await post(`/api/workflows/runs/${runId}/retry`);
      await continueRunStream();
      return;
    }
    await sendMessage({ text: value });
  }

  const gateTitle = gate.operatorView?.workspace.title || "Draft review";
  const gateSubtitle = gate.interaction?.question?.trim() || gateTitle;
  const gateHint = gate.operatorView?.blocks.some((block) => block.surface === "review.email" || block.surface === "review.draft")
    ? "Edit the draft above if needed, then approve, request changes, or reject."
    : "Choose how to continue this run.";
  const showGateComposer = gate.show && gate.operatorView && !submittedAnswer;

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
        <Conversation>
          <ConversationContent className={`mx-auto max-w-3xl gap-8 px-4 pb-40 pt-16 transition-[padding-bottom] ${showGateComposer ? "pb-[560px]" : "pb-40"}`}>
            <ScrollOnUpdate />

            {(error || run.error_json?.message) ? (
              <Message from="assistant">
                <MessageContent>
                  <p className="text-sm text-[#991b1b]">{error ?? run.error_json?.message}</p>
                </MessageContent>
              </Message>
            ) : null}

            {transcriptMessages.map((message, index) => {
              if (isTriggerSeedMessage(message, index)) {
                const summary = parseTriggerSummary(readMessageText(message));
                if (summary) return <TriggerCard key={message.id} summary={summary} />;
              }
              return null;
            })}

            {stepTranscript.map((block) => (
              <div key={block.message.id} className="flex w-full flex-col gap-4">
                <Message from={block.message.role}>
                  <MessageContent className="w-full">
                    <TranscriptMessageContent
                      message={block.message}
                      renderTool={renderRunTool}
                      shouldRenderText={({ text }) => shouldRenderAssistantText(text)}
                    />
                  </MessageContent>
                </Message>

                {block.step.id === artifactStepAttemptId && displayArtifact ? (
                  <Message from="assistant" className="max-w-none">
                    <MessageContent className="w-full max-w-none border-0 bg-transparent p-0 shadow-none">
                      <ArtifactRenderer
                        artifact={toArtifactRecord(displayArtifact)}
                        flushRef={canvasFlushRef}
                        runId={runId}
                        saving={busy}
                        onSave={async (data) => {
                          await saveCanvasEmail(displayArtifact.artifact_key, data as {
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
              </div>
            ))}

            {looseTranscriptMessages.map((message) => (
              <Message key={message.id} from={message.role === "user" ? "user" : "assistant"}>
                <MessageContent className="w-full">
                  <TranscriptMessageContent
                    message={message}
                    renderTool={renderRunTool}
                    shouldRenderText={message.role === "assistant" ? ({ text }) => shouldRenderAssistantText(text) : undefined}
                  />
                </MessageContent>
              </Message>
            ))}

            {showWorking ? (
              <Message from="assistant">
                <MessageContent>
                  <div className="flex items-center gap-2 text-sm text-[#6b7280]">
                    <Loader2 className="size-4 animate-spin" />
                    Working…
                  </div>
                </MessageContent>
              </Message>
            ) : null}
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
                <p className="px-4 pt-3 text-[12px] leading-5 text-[#6b7280]">{gateHint}</p>
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
                    placeholder="Message the loop runner..."
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

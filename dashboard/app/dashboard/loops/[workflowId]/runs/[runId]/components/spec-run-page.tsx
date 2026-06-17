"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { motion } from "motion/react";
import { Bot, ChevronRight, Loader2, RefreshCw, X } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { cn } from "@/lib/utils";
import { dedupeChatMessagesById } from "@/lib/chat-messages";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { EditorialMetaTag } from "./editorial-run-ui";
import {
  ChildAgentRow,
  ChildAgentsHeader,
  ChildAgentsShell,
  ParentAgentRow,
  formatSupervisorDisplayName,
  formatWorkerDisplayName,
  resolveStepToolRefs,
  type ParentRunPhase,
  type StepRowPhase,
} from "./agent-panel-ui";

type SpecRunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  error_json?: { message?: string };
  definition?: {
    goal?: string;
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name?: string; task?: string; tools?: Array<{ ref: string }> }>;
    };
  };
  steps: Array<{
    id: string;
    step_index: number;
    agent_id: string;
    agent_snapshot: { id?: string; name?: string; task?: string; tools?: Array<{ ref: string }> };
    attempt: number;
    status: string;
  }>;
};

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "blocked", "waiting_for_interaction"]);

function statusLabel(status: string): string {
  if (status === "waiting_for_interaction" || status === "waiting_for_approval") {
    return "Paused · Needs approval";
  }
  return status.replace(/_/g, " ");
}

function RunStatusPill({ status }: { status: string }) {
  const tone = status === "succeeded"
    ? "border-[#86c8a8] bg-[#edf8f2] text-[#166534]"
    : status === "failed" || status === "blocked" || status === "cancelled"
      ? "border-[#d9a3a3] bg-[#fdf2f2] text-[#991b1b]"
      : status === "waiting_for_interaction" || status === "waiting_for_approval"
        ? "border-[#9bb8d9] bg-[#edf3fb] text-[#1e4070]"
        : status === "running"
          ? "border-[#b8c9dc] bg-[#f0f4f9] text-[#334155]"
          : "border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]";
  return (
    <span
      className={cn("inline-flex items-center border px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase", tone)}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {statusLabel(status)}
    </span>
  );
}

function resolveCurrentStep(
  steps: SpecRunProjection["steps"],
  runStatus: string,
): SpecRunProjection["steps"][number] | null {
  const gateStep = steps.find((step) => step.status === "waiting_for_interaction" || step.status === "waiting_for_gate");
  if (gateStep) return gateStep;
  const runningStep = steps.find((step) => step.status === "running");
  if (runningStep) return runningStep;
  if (runStatus === "succeeded") return steps[steps.length - 1] ?? null;
  return steps.find((step) => step.status !== "succeeded" && step.status !== "cancelled") ?? steps[0] ?? null;
}

function resolveStepRowPhase(
  step: SpecRunProjection["steps"][number],
  currentStep: SpecRunProjection["steps"][number] | null,
  runStatus: string,
): StepRowPhase {
  const isCurrent = currentStep?.id === step.id;
  if (isCurrent && (step.status === "waiting_for_interaction" || step.status === "waiting_for_gate")) {
    return "current_gate";
  }
  if (isCurrent && step.status === "running") return "current_running";
  if (step.status === "running") return "running";
  if (step.status === "failed" || step.status === "cancelled") return "failed";
  if (step.status === "succeeded" || step.status === "approved") return "done";
  if (currentStep && step.step_index > currentStep.step_index) return "queued";
  if (runStatus === "running" && isCurrent) return "current_running";
  return "queued";
}

function resolveParentRunPhase(
  runStatus: string,
  pendingApproval: boolean,
): ParentRunPhase {
  if (pendingApproval || runStatus === "waiting_for_interaction" || runStatus === "waiting_for_approval") {
    return "paused";
  }
  if (runStatus === "failed" || runStatus === "blocked" || runStatus === "cancelled") return "blocked";
  if (runStatus === "running" || runStatus === "queued") return "running";
  if (runStatus === "succeeded") return "done";
  return "idle";
}

function EditorialSidebarPanel({
  title,
  icon: Icon,
  meta,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-[#d1d5db] bg-white">
      <header className="flex items-center justify-between border-b border-[#e5e7eb] bg-[#fafafa] px-5 py-3.5">
        <h2
          className="flex items-center gap-2 text-[14px] font-bold tracking-[-0.02em] text-[#111827]"
          style={{ fontFamily: "var(--font-title)" }}
        >
          {Icon ? <Icon className="size-4 text-[#6b7280]" /> : null}
          {title}
        </h2>
        {meta}
      </header>
      {children}
    </section>
  );
}

function ScrollOnToolComplete({ messages }: { messages: UIMessage[] }) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  const lastCompletedRef = useRef<string | null>(null);

  useEffect(() => {
    const completedTool = messages
      .flatMap((message) => message.parts)
      .find((part) => isToolUIPart(part) && part.state === "output-available" && "toolCallId" in part && part.toolCallId !== lastCompletedRef.current);

    if (completedTool && "toolCallId" in completedTool) {
      lastCompletedRef.current = completedTool.toolCallId;
      if (isAtBottom) {
        void scrollToBottom({
          animation: { damping: 0.8, stiffness: 0.04, mass: 1.5 },
          preserveScrollPosition: true,
        });
      }
    }
  }, [messages, scrollToBottom, isAtBottom]);

  return null;
}

function CollapsibleTool({ part, children }: { part: ToolPart; children: React.ReactNode }) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const isCompleted = part.state === "output-available";
  const open = isCompleted ? (userOpen ?? false) : (userOpen ?? true);

  return (
    <Tool open={open} onOpenChange={setUserOpen}>
      {children}
    </Tool>
  );
}

function SpecRunChatTranscript({
  messages,
  error,
  addToolApprovalResponse,
}: {
  messages: UIMessage[];
  error: Error | undefined;
  addToolApprovalResponse: (input: { id: string; approved: boolean }) => void;
}) {
  const transcriptMessages = useMemo(() => dedupeChatMessagesById(messages), [messages]);

  return (
    <>
      <ScrollOnToolComplete messages={transcriptMessages} />
      {transcriptMessages.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 py-16 text-center text-sm text-[#9ca3af]">
          <Bot className="size-8 text-[#cbd5e1]" />
          <p>The loop runner will stream agent progress here.</p>
        </div>
      ) : null}
      {transcriptMessages.map((message) => (
        <Message from={message.role} key={message.id}>
          <MessageContent>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return <MessageResponse key={index}>{part.text}</MessageResponse>;
              }
              if (isReasoningUIPart(part)) {
                const reasoningText = part.text?.trim() ?? "";
                if (!reasoningText && part.state !== "streaming") return null;
                return (
                  <Reasoning
                    isStreaming={part.state === "streaming"}
                    defaultOpen={part.state === "streaming"}
                    key={`reasoning-${index}`}
                  >
                    <ReasoningTrigger />
                    <ReasoningContent>{part.text}</ReasoningContent>
                  </Reasoning>
                );
              }
              if (isToolUIPart(part)) {
                const toolName = getToolName(part);
                if (part.state === "approval-requested" || part.state === "approval-responded" || part.state === "output-denied") {
                  return (
                    <Confirmation approval={part.approval} key={index} state={part.state}>
                      <ConfirmationTitle>Approve <strong>{toolName}</strong>?</ConfirmationTitle>
                      <ConfirmationRequest>
                        <p className="text-sm text-muted-foreground">This connector action requires your approval before execution.</p>
                      </ConfirmationRequest>
                      <ConfirmationAccepted>Approved.</ConfirmationAccepted>
                      <ConfirmationRejected>Rejected.</ConfirmationRejected>
                      <ConfirmationActions>
                        <ConfirmationAction
                          onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: false })}
                          variant="outline"
                          className="border-[#d1d5db] text-[#6b7280] hover:bg-[#fafafa]"
                        >
                          Reject
                        </ConfirmationAction>
                        <ConfirmationAction
                          onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })}
                          className="bg-[#111827] text-white hover:opacity-85"
                        >
                          Approve
                        </ConfirmationAction>
                      </ConfirmationActions>
                    </Confirmation>
                  );
                }
                return (
                  <CollapsibleTool key={index} part={part}>
                    {part.type === "dynamic-tool"
                      ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
                      : <ToolHeader type={part.type} state={part.state} />}
                    <ToolContent
                      className={cn(
                        "transition-all",
                        part.state !== "output-available" && [
                          "max-h-[360px] overflow-hidden",
                          "[mask-image:linear-gradient(to_bottom,black_85%,transparent_100%)]",
                          "[-webkit-mask-image:linear-gradient(to_bottom,black_85%,transparent_100%)]",
                        ],
                      )}
                    >
                      <ToolInput input={part.input} />
                      <ToolOutput output={part.output} errorText={part.errorText} />
                    </ToolContent>
                  </CollapsibleTool>
                );
              }
              return null;
            })}
          </MessageContent>
        </Message>
      ))}
      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
    </>
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
  const [run, setRun] = useState<SpecRunProjection>(initialRun);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const refreshRun = useCallback(async () => {
    const response = await fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.run) {
      setRun(payload.run as SpecRunProjection);
    }
    await onRefresh();
  }, [onRefresh, runId]);

  useEffect(() => {
    setRun(initialRun);
  }, [initialRun]);

  const { messages, sendMessage, status: chatStatus, setMessages, addToolApprovalResponse, stop, error: chatError } = useChat({
    id: runId,
    transport: new DefaultChatTransport({
      api: `/api/workflows/loops/${workflowId}/run/chat`,
      prepareSendMessagesRequest: ({ messages: chatMessages, id }) => ({
        body: {
          runId: id,
          messages: chatMessages,
        },
      }),
    }),
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: currentMessages })
      || lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMessages }),
    onFinish: () => {
      void refreshRun();
    },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workflows/runs/${runId}/messages`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;
        if (Array.isArray(payload.messages)) {
          setMessages(dedupeChatMessagesById(payload.messages));
        }
      } catch {
        // Best-effort message hydration.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, setMessages]);

  useEffect(() => {
    if (terminalStatuses.has(run.status) && chatStatus !== "streaming" && chatStatus !== "submitted") return;
    const timer = window.setInterval(() => void refreshRun(), 3_000);
    return () => window.clearInterval(timer);
  }, [run.status, chatStatus, refreshRun]);

  const post = useCallback(async (path: string) => {
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Command failed");
      await refreshRun();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command failed");
    } finally {
      setBusy(null);
    }
  }, [refreshRun]);

  const latestSteps = useMemo(
    () => [...run.steps].sort((a, b) => a.step_index - b.step_index),
    [run.steps],
  );

  const pendingApproval = useMemo(
    () => messages.some((message) =>
      message.parts.some((part) => isToolUIPart(part) && part.state === "approval-requested"),
    ),
    [messages],
  );

  const currentStep = useMemo(
    () => resolveCurrentStep(latestSteps, run.status),
    [latestSteps, run.status],
  );

  const parentRunPhase = useMemo(
    () => resolveParentRunPhase(run.status, pendingApproval),
    [pendingApproval, run.status],
  );

  const doneSteps = latestSteps.filter((step) => step.status === "succeeded").length;
  const parentName = formatSupervisorDisplayName(run.definition?.agentGraph?.parent?.name ?? "Tallei Agent");
  const workerNames = latestSteps.map((step) => step.agent_snapshot?.name ?? step.agent_id);
  const roster = workerNames.length > 0
    ? `Queue: ${workerNames.map(formatWorkerDisplayName).join(" → ")}.`
    : "Queue: waiting for agents.";
  const statusLine = pendingApproval
    ? "Paused — approve the pending connector action in chat to continue."
    : parentRunPhase === "running"
      ? `Live: ${doneSteps} of ${latestSteps.length} agents complete.`
      : parentRunPhase === "done"
        ? `All ${latestSteps.length} agents finished.`
        : parentRunPhase === "blocked"
          ? "Run blocked or failed — retry when ready."
          : "Spinning up the agent queue.";

  const terminal = terminalStatuses.has(run.status);
  const canSend = !terminal && chatStatus !== "streaming" && chatStatus !== "submitted";

  return (
    <main
      className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-[#f7f8fb] text-[#121a31]"
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[1660px] flex-1 flex-col px-7 py-5">
        <header className="mb-4 shrink-0 flex items-start justify-between gap-4">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[#9ca3af]">
              <Link href="/dashboard/loops" className="hover:text-[#111827]">Loops</Link>
              <ChevronRight className="size-3.5" />
              <Link href={`/dashboard/loops/${workflowId}`} className="hover:text-[#111827]">{run.workflow_title}</Link>
              <ChevronRight className="size-3.5" />
              <span className="text-[#111827]">Run #{run.id.slice(0, 6)}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1
                className="text-[25px] font-bold leading-tight tracking-[-0.02em] text-[#111827]"
                style={{ fontFamily: "var(--font-title)" }}
              >
                {run.workflow_title}
              </h1>
              <RunStatusPill status={run.status} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Refresh"
              onClick={() => void refreshRun()}
              disabled={Boolean(busy)}
              className="grid size-9 place-items-center border border-[#d1d5db] bg-white text-[#6b7280] transition-colors hover:bg-[#fafafa] hover:text-[#111827] disabled:opacity-50"
            >
              <RefreshCw className="size-4" />
            </button>
            {terminal ? (
              <button
                type="button"
                onClick={() => void post(`/api/workflows/runs/${runId}/retry`)}
                disabled={Boolean(busy)}
                className="border border-[#111827] bg-[#111827] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-85 disabled:opacity-50"
              >
                Retry
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)}
                disabled={Boolean(busy)}
                className="grid size-9 place-items-center border border-[#d1d5db] bg-white text-[#6b7280] transition-colors hover:border-[#d9a3a3] hover:text-[#991b1b] disabled:opacity-50"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </header>

        {(error || run.error_json?.message) ? (
          <div className="mb-4 shrink-0 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error ?? run.error_json?.message}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 items-stretch gap-5 overflow-hidden lg:grid-cols-[minmax(0,1fr)_490px]">
          <section className="flex min-h-0 flex-col overflow-hidden border border-[#d1d5db] bg-white">
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[280px] bg-gradient-to-t from-slate-100/80 to-transparent" />
              <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
                <Conversation className="min-h-0 flex-1">
                  <ConversationContent className="mx-auto max-w-3xl gap-8 p-4">
                    <SpecRunChatTranscript
                      messages={messages}
                      error={chatError}
                      addToolApprovalResponse={addToolApprovalResponse}
                    />
                    {(chatStatus === "streaming" || chatStatus === "submitted" || run.status === "running") && (
                      <div className="flex items-center gap-2 text-sm text-[#6b7280]">
                        <Loader2 className="size-4 animate-spin" />
                        Running loop…
                      </div>
                    )}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>

                <div className="shrink-0 px-4 pb-4 pt-2">
                  <div className="mx-auto max-w-3xl">
                    <motion.div
                      className="relative overflow-hidden border border-[#d1d5db] bg-white transition-colors focus-within:border-[#9ca3af]"
                      layout
                      transition={{ layout: { duration: 0.32, ease: [0.16, 1, 0.3, 1] } }}
                    >
                      <PromptInput
                        className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0"
                        onSubmit={({ text }) => {
                          const value = text.trim();
                          if (!value || !canSend) return;
                          void sendMessage({ text: value });
                        }}
                      >
                        <PromptInputTextarea
                          placeholder={canSend ? "Send a follow-up to the loop runner…" : "Run finished"}
                          disabled={!canSend}
                          className="min-h-0 pr-12 pb-2"
                        />
                        <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                          <PromptInputSubmit onStop={stop} status={chatStatus} className="bg-[#111827] text-white hover:opacity-85" />
                        </PromptInputFooter>
                      </PromptInput>
                    </motion.div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="min-h-0 space-y-5 overflow-y-auto">
            <EditorialSidebarPanel
              title="Agents"
              icon={Bot}
              meta={(
                <EditorialMetaTag tone={run.status === "succeeded" ? "neutral" : "blue"}>
                  {doneSteps}/{latestSteps.length} done
                </EditorialMetaTag>
              )}
            >
              <ParentAgentRow
                parentName={parentName}
                roster={roster}
                statusLine={statusLine}
                parentRunPhase={parentRunPhase}
                onHire={() => undefined}
                onSelect={() => setSelectedStepId(null)}
                onInfo={() => undefined}
              />
              <ChildAgentsShell>
                <ChildAgentsHeader count={latestSteps.length} />
                {latestSteps.map((step) => {
                  const selected = selectedStepId === step.id || (!selectedStepId && currentStep?.id === step.id);
                  const phase = resolveStepRowPhase(step, currentStep, run.status);
                  const isCurrent = currentStep?.id === step.id;
                  return (
                    <ChildAgentRow
                      key={step.id}
                      step={step}
                      phase={phase}
                      selected={selected}
                      isCurrent={isCurrent}
                      toolRefs={resolveStepToolRefs(step, run.definition)}
                      onSelect={() => setSelectedStepId(step.id)}
                      onHire={() => undefined}
                      onInfo={() => undefined}
                      onRerun={() => undefined}
                    />
                  );
                })}
              </ChildAgentsShell>
              {latestSteps.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-[#9ca3af]">Waiting for agents to start.</p>
              ) : null}
            </EditorialSidebarPanel>
          </aside>
        </div>
      </div>
    </main>
  );
}

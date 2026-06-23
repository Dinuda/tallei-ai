"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { Activity, Braces, Paperclip, Plus } from "lucide-react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { TranscriptMessageContent, CollapsibleTool } from "@/components/ai-elements/transcript-message";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
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
import { IssueNotice, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import { BuilderAppSelector, type AppSelectionOutput } from "@/components/builder-app-selector";
import { BuilderArtifactEditor, type ArtifactSetupOutput, updateArtifactToolOutput } from "@/components/builder-artifact-editor";
import { BuilderConnectorChecklist } from "@/components/builder-connector-checklist";
import { BuilderKnowledgeBaseSelector, type KnowledgeBaseSelectionOutput } from "@/components/builder-knowledge-base-selector";
import { BuilderRequirementSelector, type RequirementSetupOutput } from "@/components/builder-requirement-selector";
import { BuilderRunJsonSheet } from "@/components/builder-run-json-sheet";
import { BuilderScheduleSelector, type ScheduleSelectionOutput } from "@/components/builder-schedule-selector";
import { BuilderTestRunPanel } from "@/components/agent-persona/builder-test-run-panel";
import {
  BuilderAgentSpawnPanel,
  isSpecDraftSpawnTool,
} from "@/components/agent-persona/builder-agent-spawn-panel";
import { notifyLoopBuilderSessionUpdated } from "@/components/loop-builder-header";
import type { EmailTemplateId, EmailTemplateProps } from "@/lib/email-artifacts/types";
import {
  emptyBuilderLiveUsage,
  normalizeBuilderLiveUsage,
  sumBuilderLiveUsage,
} from "@/lib/loop-builder-usage";
import { isBuilderToolInputReady } from "@/lib/loop-builder-transcript";
import { buildBuilderRunFlow } from "@/lib/builder-run-flow";
import { dedupeChatMessagesById } from "@/lib/chat-messages";

type BuilderSessionPayload = {
  session?: {
    id?: string;
    builderState?: string;
    phase?: string;
    workflowId?: string | null;
    analyzerUsage?: unknown;
    buildContract?: {
      requirements?: Array<{
        kind?: string;
        required?: boolean;
        status?: string;
        value?: unknown;
      }>;
    } | null;
    discoveredToolContracts?: Array<{
      toolRef?: string;
      name?: string;
      constraints?: { connected?: boolean };
    }>;
    builderTrace?: Array<{
      id: string;
      at: string;
      kind: "analyzer_phase" | "chat_turn";
      phase?: string;
      agentLabel?: string;
      systemPrompt?: string;
    }>;
  } | null;
  messages?: UIMessage[];
  commands?: Array<Record<string, unknown>>;
  turns?: unknown[];
  actions?: unknown[];
  recalledPreferences?: unknown;
};

type BuilderEvent = {
  type?: string;
  at?: string;
  data?: {
    state?: string;
    to?: string;
    from?: string;
    actionName?: string;
    error?: string;
  };
};

const LoopSuggestionCards = dynamic(
  () => import("@/components/loop-suggestion-cards").then((mod) => mod.LoopSuggestionCards),
  { ssr: false },
);

const CLIENT_OUTPUT_AUTOSUBMIT_TOOLS = new Set([
  "interactivePrompt",
  "appSelection",
  "connectorSetup",
  "scheduleSetup",
  "knowledgeBaseSetup",
  "renderType",
  "artifactSetup",
  "requirementSetup",
]);

const BACKEND_OUTPUT_AUTOCONTINUE_TOOLS = new Set([
  "resolveIntent",
  "getAvailableTools",
  "resolveBuildRequirement",
  "previewAgentPlan",
  "saveLoop",
  "runBuilderTest",
  "runVerification",
  "confirmActivation",
]);

const CLIENT_GATE_TOOLS = new Set([
  "interactivePrompt",
  "appSelection",
  "connectorSetup",
  "scheduleSetup",
  "knowledgeBaseSetup",
  "artifactSetup",
  "requirementSetup",
]);

function summarizeToolOutputForAutoSend(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  return {
    answerText: typeof record.answerText === "string" ? record.answerText : undefined,
    requirementId: typeof record.requirementId === "string" ? record.requirementId : undefined,
    mode: typeof record.mode === "string" ? record.mode : undefined,
    selectedToolkits: Array.isArray(record.selectedToolkits)
      ? record.selectedToolkits.map((entry) => (
        entry && typeof entry === "object" ? (entry as { slug?: unknown }).slug : entry
      ))
      : undefined,
    artifactPersisted: record.artifactPersisted === true ? true : undefined,
  };
}

function builderAutoSendSignature(messages: UIMessage[]): string | null {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") return null;

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const toolParts = message.parts.slice(lastStepStartIndex + 1).filter(isToolUIPart);
  if (toolParts.length === 0) return null;

  const hasApprovalResponse = toolParts.some((part) => part.state === "approval-responded");
  if (!hasApprovalResponse) {
    const hasContinuableOutput = toolParts.some((part) => (
      part.state === "output-available"
      && (
        CLIENT_OUTPUT_AUTOSUBMIT_TOOLS.has(getToolName(part))
        || BACKEND_OUTPUT_AUTOCONTINUE_TOOLS.has(getToolName(part))
      )
    ));
    if (!hasContinuableOutput) return null;
    if (toolParts.some((part) => (
      part.state !== "output-available"
      || (
        !CLIENT_OUTPUT_AUTOSUBMIT_TOOLS.has(getToolName(part))
        && !BACKEND_OUTPUT_AUTOCONTINUE_TOOLS.has(getToolName(part))
      )
    ))) {
      return null;
    }
  }

  return JSON.stringify({
    messageId: message.id,
    tools: toolParts.map((part) => ({
      toolCallId: part.toolCallId,
      toolName: getToolName(part),
      state: part.state,
      approvalId: "approval" in part ? part.approval?.id : undefined,
      errorText: "errorText" in part ? part.errorText : undefined,
      output: "output" in part ? summarizeToolOutputForAutoSend(part.output) : undefined,
    })),
  });
}

function builderStateAgentLabel(state: string | undefined): string {
  if (!state) return "Builder";
  if (state.startsWith("intent.")) return "Intent Analyst";
  if (state.startsWith("requirements.")) return "Setup Coordinator";
  if (state.startsWith("compile.")) return "Flow Architect";
  if (state.startsWith("verification.")) return "Launch Specialist";
  if (state === "complete") return "Complete";
  if (state === "failed") return "Failed";
  return "Builder";
}

function isPendingClientGate(part: ToolPart): boolean {
  if (!CLIENT_GATE_TOOLS.has(getToolName(part))) return false;
  return part.state === "input-available" || part.state === "input-streaming";
}

function findActiveClientGate(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && isPendingClientGate(part) && isBuilderToolInputReady(part)) {
        return part;
      }
    }
  }
  return null;
}

function latestAssistantMessageId(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

function getConnectedSearchToolkits(session: BuilderSessionPayload["session"]): string[] {
  return [...new Set((session?.discoveredToolContracts ?? [])
    .filter((contract) => contract.constraints?.connected !== false)
    .map((contract) => String(contract.toolRef ?? contract.name ?? "").split(".")[0].trim().toLowerCase())
    .filter(Boolean))];
}

function findLatestRenderTypeDraftTemplates(
  messages: UIMessage[],
): Array<{
  templateId: EmailTemplateId;
  name?: string;
  props?: Partial<EmailTemplateProps>;
}> | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (!part || !isToolUIPart(part) || getToolName(part) !== "renderType") continue;
      const payload = part.state === "output-available" ? part.output : part.input;
      const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as {
          draftTemplates?: Array<{
            templateId: EmailTemplateId;
            name?: string;
            props?: Partial<EmailTemplateProps>;
          }>;
        }
        : undefined;
      if (record?.draftTemplates?.length) return record.draftTemplates;
    }
  }
  return undefined;
}

function shouldRenderTranscriptText({ text }: { text: string }): boolean {
  return Boolean(text.trim());
}

export default function NewLoopBuilderPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<BuilderSessionPayload["session"]>(null);
  const [commands, setCommands] = useState<Array<Record<string, unknown>>>([]);
  const [events, setEvents] = useState<BuilderEvent[]>([]);
  const [recalledPreferences, setRecalledPreferences] = useState<Array<{ id: string; text: string; category?: string | null }>>([]);
  const [savedUsage, setSavedUsage] = useState(emptyBuilderLiveUsage);
  const [liveUsage, setLiveUsage] = useState<ReturnType<typeof emptyBuilderLiveUsage> | null>(null);
  const [composerText, setComposerText] = useState("");
  const [runJsonOpen, setRunJsonOpen] = useState(false);
  const [appSelectionReady, setAppSelectionReady] = useState(false);
  const autoSendSignatureRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/conductor/chat",
    body: () => ({ sessionId: sessionIdRef.current ?? undefined }),
  }), []);

  const fetchSession = useCallback(async (id: string): Promise<BuilderSessionPayload> => {
    const response = await fetch(`/api/conductor/sessions/${id}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to load builder session");
    return payload as BuilderSessionPayload;
  }, []);

  const applySessionPayload = useCallback((id: string, payload: BuilderSessionPayload) => {
    setSessionId(id);
    setSession(payload.session ?? null);
    setCommands(payload.commands ?? []);
    setSavedUsage(normalizeBuilderLiveUsage(payload.session?.analyzerUsage));
    setRecalledPreferences(Array.isArray(payload.recalledPreferences)
      ? payload.recalledPreferences as Array<{ id: string; text: string; category?: string | null }>
      : []);
    notifyLoopBuilderSessionUpdated(id);
  }, []);

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const shouldAutoSend = lastAssistantMessageIsCompleteWithApprovalResponses({ messages: currentMessages })
        || lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMessages });
      if (!shouldAutoSend) return false;

      const signature = builderAutoSendSignature(currentMessages);
      if (!signature || autoSendSignatureRef.current === signature) return false;
      autoSendSignatureRef.current = signature;
      return true;
    },
    onData: (part) => {
      if (part.type === "data-session" && "data" in part) {
        const nextId = (part.data as { sessionId?: string }).sessionId;
        if (nextId && nextId !== sessionIdRef.current) {
          setSessionId(nextId);
          window.history.replaceState(null, "", `/dashboard/loops/new?session=${encodeURIComponent(nextId)}`);
        }
        return;
      }
      if (part.type === "data-usage" && "data" in part) {
        setLiveUsage(normalizeBuilderLiveUsage(part.data));
        return;
      }
      if (part.type === "data-builder-event" && "data" in part) {
        setEvents((current) => [...current, part.data as BuilderEvent]);
      }
    },
    onFinish: () => {
      setLiveUsage(null);
      const id = sessionIdRef.current;
      if (!id) return;
      void fetchSession(id)
        .then((payload) => {
          applySessionPayload(id, payload);
          if (Array.isArray(payload.messages)) {
            setMessages(dedupeChatMessagesById(payload.messages));
          }
        })
        .catch((error) => {
          console.error("[loop-builder] failed to refresh session:", error);
        });
    },
  });

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("session");
    if (!id) return;
    void fetchSession(id)
      .then((payload) => {
        applySessionPayload(id, payload);
        if (Array.isArray(payload.messages)) {
          setMessages(dedupeChatMessagesById(payload.messages));
        }
      })
      .catch((error) => {
        console.error("[loop-builder] failed to load session:", error);
      });
  }, [applySessionPayload, fetchSession, setMessages]);

  useEffect(() => {
    setAppSelectionReady(false);
  }, [findActiveClientGate(messages)?.toolCallId]);

  const activeGate = findActiveClientGate(messages);
  const activeGateName = activeGate ? getToolName(activeGate) : null;
  const connectedSearchToolkits = useMemo(() => getConnectedSearchToolkits(session), [session]);
  const draftTemplates = useMemo(() => findLatestRenderTypeDraftTemplates(messages), [messages]);
  const latestAssistantId = latestAssistantMessageId(messages);
  const currentUsage = liveUsage ?? savedUsage;
  const busy = status === "submitted" || status === "streaming";
  const showSuggestions = messages.length === 0 && !sessionId;
  const stateLabel = builderStateAgentLabel(session?.builderState);
  const lastTransition = [...events].reverse().find((entry) => entry.type === "builder.state.transitioned");
  const runJsonPayload = useMemo(() => ({
    sessionId,
    session,
    usage: currentUsage,
    recalledPreferences,
    events,
    flow: buildBuilderRunFlow({
      trace: session?.builderTrace ?? [],
      phaseHistory: [],
      commands,
      messages,
    }),
    messages,
  }), [commands, currentUsage, events, messages, recalledPreferences, session, sessionId]);

  const applyMessages = useCallback(
    (value: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
      setMessages((prev) => dedupeChatMessagesById(typeof value === "function" ? value(prev) : value));
    },
    [setMessages],
  );

  const submitComposerText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setComposerText("");
    await sendMessage({ text: trimmed });
  }, [busy, sendMessage]);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-white">
      <Conversation className="min-h-0 flex-1 basis-0">
        <ConversationContent className="mx-auto max-w-3xl gap-8 p-4">
          {showSuggestions ? (
            <LoopSuggestionCards
              className="max-w-3xl"
              onSelect={(text) => void submitComposerText(text)}
            />
          ) : null}

          {messages.map((message) => {
            const isStreamingAssistant = busy && message.role === "assistant" && message.id === latestAssistantId;
            const specDraftSpawnPartIndex = lastSpecDraftSpawnPartIndex(message.parts);
            return (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  <TranscriptMessageContent
                    expandReasoning={false}
                    isStreaming={isStreamingAssistant}
                    message={message}
                    shouldRenderText={shouldRenderTranscriptText}
                    renderTool={(part, toolName, index) => {
                      if (part.state === "output-error") return <IssueNotice key={index} />;
                      if (isPendingClientGate(part)) return null;
                      if (toolName === "runBuilderTest") {
                        return <BuilderTestRunPanel commands={commands} key={index} part={part} />;
                      }
                      if (isSpecDraftSpawnTool(toolName, part) && index === specDraftSpawnPartIndex) {
                        return <BuilderAgentSpawnPanel commands={commands} key={index} part={part} />;
                      }
                      if (isSpecDraftSpawnTool(toolName, part)) return null;
                      if (part.state === "approval-requested" || part.state === "approval-responded" || part.state === "output-denied") {
                        return (
                          <Confirmation approval={part.approval} key={index} state={part.state}>
                            <ConfirmationTitle>Approve <strong>{toolName}</strong>?</ConfirmationTitle>
                            <ConfirmationRequest>
                              <p className="text-sm text-muted-foreground">This operation changes a persisted artifact or workflow.</p>
                            </ConfirmationRequest>
                            <ConfirmationAccepted>Approved.</ConfirmationAccepted>
                            <ConfirmationRejected>Rejected.</ConfirmationRejected>
                            <ConfirmationActions>
                              <ConfirmationAction
                                className="border-[#d1d5db] text-[#6b7280] hover:bg-[#fafafa]"
                                onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: false })}
                                variant="outline"
                              >
                                Reject
                              </ConfirmationAction>
                              <ConfirmationAction
                                className="bg-[#111827] text-white hover:opacity-85"
                                onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })}
                              >
                                Approve
                              </ConfirmationAction>
                            </ConfirmationActions>
                          </Confirmation>
                        );
                      }
                      return <GenericBuilderTool key={index} part={part} />;
                    }}
                  />
                </MessageContent>
              </Message>
            );
          })}

          {lastTransition?.data?.to ? (
            <div className="flex items-center gap-2 py-1">
              <span className="inline-flex rounded-full border border-lime-200 bg-lime-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-lime-800">
                {builderStateAgentLabel(lastTransition.data.to)}
              </span>
            </div>
          ) : null}

          {busy ? (
            <Message from="assistant">
              <MessageContent>
                <TranscriptThinkingIndicator />
              </MessageContent>
            </Message>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 border-t border-slate-100 bg-white px-4 pb-4 pt-2">
        <div className="mx-auto max-w-3xl">
          <div className="relative overflow-hidden border border-[#d1d5db] bg-white transition-colors focus-within:border-[#9ca3af]">
            {activeGate ? (
              <ActiveClientGate
                appSelectionReady={appSelectionReady}
                connectedSearchToolkits={connectedSearchToolkits}
                draftTemplates={draftTemplates}
                gate={activeGate}
                name={activeGateName}
                onAppSelectionReadyChange={setAppSelectionReady}
                onArtifactSave={(next) => applyMessages((current) => updateArtifactToolOutput(current, activeGate.toolCallId, next))}
                onToolOutput={(tool, output) => addToolOutput({ tool, toolCallId: activeGate.toolCallId, output })}
                recalledPreferences={recalledPreferences}
                sessionId={sessionId}
                status={status}
              />
            ) : busy ? (
              <div className="flex min-h-[72px] items-center px-4 py-5" role="status">
                <TranscriptThinkingIndicator />
              </div>
            ) : (
              <PromptInput
                className="[&_[data-slot=input-group]]:min-h-[96px] [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:!ring-0"
                onSubmit={async ({ text }) => submitComposerText(text)}
              >
                <PromptInputTextarea
                  className="min-h-0 pr-12 pb-2"
                  onChange={(event) => setComposerText(event.currentTarget.value)}
                  placeholder="Describe the loop, answer a clarification, or request a refinement..."
                  value={composerText}
                />
                <div className="absolute bottom-3 left-4 flex items-center gap-2 text-slate-400">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="flex size-7 items-center justify-center rounded-md bg-slate-100 transition-colors hover:bg-slate-200">
                        <Plus size={16} className="text-slate-600" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 border border-[#d1d5db] bg-white p-2">
                      <DropdownMenuItem className="gap-3 px-3 py-2 text-[14px]">
                        <Paperclip size={18} className="text-slate-700" />
                        <span>Add photos & files</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700">
                        <Activity size={14} className="text-slate-600" />
                        <span>Cost: ${currentUsage.estimatedCostUsd.toFixed(4)}</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 border border-slate-200 bg-white p-3 text-xs text-slate-600">
                      <div className="space-y-1.5">
                        <div className="flex justify-between"><span>Calls</span><span>{currentUsage.calls}</span></div>
                        <div className="flex justify-between"><span>Prompt tokens</span><span>{currentUsage.promptTokens}</span></div>
                        <div className="flex justify-between"><span>Completion tokens</span><span>{currentUsage.completionTokens}</span></div>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <button
                    type="button"
                    className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
                    onClick={() => setRunJsonOpen(true)}
                    title="View full builder run JSON"
                  >
                    <Braces size={14} className="text-slate-600" />
                    <span>Run JSON</span>
                  </button>
                </div>
                <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                  <PromptInputSubmit
                    disabled={!composerText.trim()}
                    status={status}
                    onClick={busy ? stop : undefined}
                  />
                </PromptInputFooter>
              </PromptInput>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
            <span>{stateLabel}</span>
            <span>Tallei can make mistakes. Check important info.</span>
          </div>
        </div>
      </div>

      <BuilderRunJsonSheet
        open={runJsonOpen}
        onOpenChange={setRunJsonOpen}
        payload={runJsonPayload}
      />
    </div>
  );
}

function ActiveClientGate({
  appSelectionReady,
  connectedSearchToolkits,
  draftTemplates,
  gate,
  name,
  onAppSelectionReadyChange,
  onArtifactSave,
  onToolOutput,
  recalledPreferences,
  sessionId,
  status,
}: {
  appSelectionReady: boolean;
  connectedSearchToolkits: string[];
  draftTemplates?: Array<{
    templateId: EmailTemplateId;
    name?: string;
    props?: Partial<EmailTemplateProps>;
  }>;
  gate: ToolPart;
  name: string | null;
  onAppSelectionReadyChange: (ready: boolean) => void;
  onArtifactSave: (output: ArtifactSetupOutput) => void;
  onToolOutput: (tool: string, output: unknown) => void;
  recalledPreferences: Array<{ id: string; text: string; category?: string | null }>;
  sessionId: string | null;
  status: string;
}) {
  const disabled = status !== "ready";
  const input = gate.input && typeof gate.input === "object" && !Array.isArray(gate.input)
    ? gate.input as Record<string, unknown>
    : {};

  if (name === "appSelection") {
    return (
      <>
        {!appSelectionReady ? (
          <div className="flex min-h-[72px] items-center px-4 py-5">
            <TranscriptThinkingIndicator variant="shimmer" label="Loading app options..." />
          </div>
        ) : null}
        <div className={appSelectionReady ? undefined : "hidden"} aria-hidden={!appSelectionReady}>
          <BuilderAppSelector
            allowMultiple={typeof input.allowMultiple === "boolean" ? input.allowMultiple : true}
            onComplete={(output: AppSelectionOutput) => onToolOutput("appSelection", output)}
            onReadyChange={onAppSelectionReadyChange}
            question={typeof input.question === "string" ? input.question : "Where do your customers send support requests?"}
            recommendedToolkitSlugs={Array.isArray(input.recommendedToolkitSlugs) ? input.recommendedToolkitSlugs.map(String) : []}
          />
        </div>
      </>
    );
  }

  if (name === "connectorSetup" && sessionId) {
    return (
      <BuilderConnectorChecklist
        onComplete={(output) => onToolOutput("connectorSetup", output)}
        requirementId={typeof input.requirementId === "string" ? input.requirementId : "connector_selection"}
        sessionId={sessionId}
      />
    );
  }

  if (name === "scheduleSetup" && sessionId) {
    return (
      <BuilderScheduleSelector
        allowOther={typeof input.allowOther === "boolean" ? input.allowOther : undefined}
        onComplete={(output: ScheduleSelectionOutput) => onToolOutput("scheduleSetup", output)}
        options={Array.isArray(input.options) ? input.options as Parameters<typeof BuilderScheduleSelector>[0]["options"] : undefined}
        question={typeof input.question === "string" ? input.question : "How often should this loop run?"}
        recommendedOptionIds={Array.isArray(input.recommendedOptionIds) ? input.recommendedOptionIds.map(String) : undefined}
        requirementId={typeof input.requirementId === "string" ? input.requirementId : "trigger_schedule"}
        sessionId={sessionId}
        subtitle={typeof input.subtitle === "string" ? input.subtitle : undefined}
      />
    );
  }

  if (name === "knowledgeBaseSetup") {
    return (
      <BuilderKnowledgeBaseSelector
        connectedSearchToolkits={connectedSearchToolkits}
        onComplete={(output: KnowledgeBaseSelectionOutput) => onToolOutput("knowledgeBaseSetup", output)}
        recalledPreferences={recalledPreferences}
        requirementId={typeof input.requirementId === "string" ? input.requirementId : "grounding"}
      />
    );
  }

  if (name === "artifactSetup") {
    return (
      <BuilderArtifactEditor
        draftTemplates={draftTemplates}
        inputReady={gate.state === "input-available"}
        onComplete={(output: ArtifactSetupOutput) => onToolOutput("artifactSetup", output)}
        onSave={onArtifactSave}
        requirementId={typeof input.requirementId === "string" ? input.requirementId : "artifact_contract"}
        sessionId={sessionId ?? undefined}
        toolCallId={gate.toolCallId}
      />
    );
  }

  if (name === "requirementSetup") {
    return (
      <RequirementSetupTool
        disabled={disabled}
        onSubmit={(output) => onToolOutput("requirementSetup", output)}
        part={gate}
      />
    );
  }

  if (name === "interactivePrompt") {
    return (
      <InteractivePromptTool
        disabled={disabled}
        onSubmit={(answer) => onToolOutput("interactivePrompt", answer)}
        part={gate}
      />
    );
  }

  return (
    <div className="flex min-h-[72px] items-center px-4 py-5">
      <TranscriptThinkingIndicator />
    </div>
  );
}

function InteractivePromptTool({
  part,
  disabled,
  onSubmit,
}: {
  part: ToolPart;
  disabled: boolean;
  onSubmit: (answer: InteractivePromptAnswer) => void;
}) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as {
      question?: string;
      options?: InteractivePromptOption[];
      recommendedOptionIds?: string[];
      allowMultiple?: boolean;
      allowOther?: boolean;
    }
    : {};
  const output = part.state === "output-available" && part.output && typeof part.output === "object"
    ? part.output as InteractivePromptAnswer
    : undefined;
  return (
    <InteractivePromptMenu
      allowMultiple={input.allowMultiple}
      allowOther={input.allowOther}
      disabled={disabled || part.state !== "input-available"}
      onSubmit={onSubmit}
      options={input.options ?? []}
      placement="composer"
      question={input.question ?? "Choose an option"}
      recommendedOptionIds={input.recommendedOptionIds}
      submittedAnswer={output}
    />
  );
}

function RequirementSetupTool({
  part,
  disabled,
  onSubmit,
}: {
  part: ToolPart;
  disabled: boolean;
  onSubmit: (output: RequirementSetupOutput) => void;
}) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as {
      requirementId?: string;
      question?: string;
      options?: InteractivePromptOption[];
      recommendedOptionIds?: string[];
      allowMultiple?: boolean;
      allowOther?: boolean;
    }
    : {};
  if (!input.question || !input.options?.length || !input.requirementId) {
    return (
      <div className="flex min-h-[72px] items-center px-4 py-5">
        <TranscriptThinkingIndicator />
      </div>
    );
  }
  return (
    <BuilderRequirementSelector
      allowMultiple={input.allowMultiple}
      allowOther={input.allowOther ?? true}
      disabled={disabled}
      onComplete={onSubmit}
      options={input.options}
      placement="composer"
      question={input.question}
      recommendedOptionIds={input.recommendedOptionIds}
      requirementId={input.requirementId}
    />
  );
}

function GenericBuilderTool({ part }: { part: ToolPart }) {
  return (
    <CollapsibleTool part={part}>
      {part.type === "dynamic-tool"
        ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <ToolInput input={part.input} />
        {part.state === "output-available" ? <ToolOutput output={part.output} /> : null}
      </ToolContent>
    </CollapsibleTool>
  );
}

function lastSpecDraftSpawnPartIndex(parts: UIMessage["parts"]): number {
  let lastIndex = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!isToolUIPart(part)) continue;
    if (isSpecDraftSpawnTool(getToolName(part), part)) lastIndex = i;
  }
  return lastIndex;
}

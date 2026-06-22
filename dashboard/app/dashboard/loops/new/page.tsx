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
import { Paperclip, Plus, Activity } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { cn } from "@/lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
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
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { TranscriptMessageContent, CollapsibleTool } from "@/components/ai-elements/transcript-message";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import {
  filterBuilderTranscriptMessages,
  isBuilderToolInputReady,
  shouldRenderBuilderTranscriptText,
  shouldShowBuilderThinking,
} from "@/lib/loop-builder-transcript";
import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
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
import { IssueNotice, type ToolPart, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { BuilderConnectorChecklist } from "@/components/builder-connector-checklist";
import { BuilderAppSelector, type AppSelectionOutput } from "@/components/builder-app-selector";
import { BuilderScheduleSelector, type ScheduleSelectionOutput } from "@/components/builder-schedule-selector";
import { BuilderKnowledgeBaseSelector, type KnowledgeBaseSelectionOutput } from "@/components/builder-knowledge-base-selector";
import { BuilderArtifactEditor, type ArtifactSetupOutput, updateArtifactToolOutput } from "@/components/builder-artifact-editor";
import { BuilderRequirementSelector, type RequirementSetupOutput } from "@/components/builder-requirement-selector";
import {
  BuilderAgentSpawnPanel,
  isSpecDraftSpawnTool,
} from "@/components/agent-persona/builder-agent-spawn-panel";
import { BuilderTestRunPanel } from "@/components/agent-persona/builder-test-run-panel";
import type { EmailTemplateId, EmailTemplateProps } from "@/lib/email-artifacts/types";
import { notifyLoopBuilderSessionUpdated } from "@/components/loop-builder-header";
import { dedupeChatMessagesById } from "@/lib/chat-messages";
import {
  emptyBuilderLiveUsage,
  normalizeBuilderLiveUsage,
  sumBuilderLiveUsage,
} from "@/lib/loop-builder-usage";
import {
  detectBuilderRecoveryState,
  findRunningBuilderCommand,
  builderRunningCommandLabel,
  hydrateBuilderMessagesFromCommands,
  latestUserPromptText,
  persistBuilderMessages,
  type BuilderCommandSnapshot,
  type BuilderRecoveryState,
} from "@/lib/builder-session-recovery";

type BuilderCommandUiSnapshot = BuilderCommandSnapshot & { usage?: unknown };

const LoopSuggestionCards = dynamic(
  () => import("@/components/loop-suggestion-cards").then((mod) => mod.LoopSuggestionCards),
  { ssr: false },
);

function lastSpecDraftSpawnPartIndex(parts: UIMessage["parts"]): number {
  let lastIndex = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!isToolUIPart(part)) continue;
    const toolName = getToolName(part);
    if (isSpecDraftSpawnTool(toolName, part)) lastIndex = i;
  }
  return lastIndex;
}

function summarizeToolOutputForAutoSend(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  return {
    answerText: typeof record.answerText === "string" ? record.answerText : undefined,
    requirementId: typeof record.requirementId === "string" ? record.requirementId : undefined,
    mode: typeof record.mode === "string" ? record.mode : undefined,
    selectedToolkits: Array.isArray(record.selectedToolkits)
      ? record.selectedToolkits.map((entry) => (
        entry && typeof entry === "object"
          ? (entry as { slug?: unknown }).slug
          : entry
      ))
      : undefined,
    templates: Array.isArray(record.templates)
      ? record.templates.map((entry) => (
        entry && typeof entry === "object"
          ? (entry as { id?: unknown; templateId?: unknown }).id ?? (entry as { templateId?: unknown }).templateId
          : entry
      ))
      : undefined,
    valueMode: record.value && typeof record.value === "object" && !Array.isArray(record.value)
      ? (record.value as { mode?: unknown }).mode
      : undefined,
    artifactPersisted: record.artifactPersisted === true ? true : undefined,
  };
}

function builderAutoSendSignature(messages: UIMessage[]): string | null {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return null;

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const toolParts = message.parts.slice(lastStepStartIndex + 1).filter(isToolUIPart);
  if (toolParts.length === 0) return null;

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

export default function NewLoopBuilderPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [builderSession, setBuilderSession] = useState<{
    phase?: string;
    workflowId?: string | null;
    error?: { message?: string } | null;
    buildContract?: {
      requirements?: Array<{
        kind?: string;
        required?: boolean;
        status?: string;
        value?: unknown;
      }>;
    } | null;
    discoveredToolContracts?: Array<{ toolRef?: string; name?: string; constraints?: { connected?: boolean } }>;
  } | null>(null);
  const [recalledPreferences, setRecalledPreferences] = useState<Array<{ id: string; text: string; category?: string | null }>>([]);
  const [dismissedPromptId, setDismissedPromptId] = useState<string | null>(null);
  const [dismissedSetupId, setDismissedSetupId] = useState<string | null>(null);
  const [commands, setCommands] = useState<BuilderCommandUiSnapshot[]>([]);
  const [recoveryState, setRecoveryState] = useState<BuilderRecoveryState>({ kind: "idle" });
  const [analyzerUsage, setAnalyzerUsage] = useState(emptyBuilderLiveUsage);
  const [liveUsageFromStream, setLiveUsageFromStream] = useState<ReturnType<typeof emptyBuilderLiveUsage> | null>(null);
  const [appSelectionUiReady, setAppSelectionUiReady] = useState(false);
  const [composerText, setComposerText] = useState("");

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const transcriptMessagesRef = useRef<UIMessage[]>([]);
  const recoveryPrefillKeyRef = useRef<string | null>(null);
  const autoSendSignatureRef = useRef<string | null>(null);
  const skipPersistRef = useRef(true);
  const hydratingRef = useRef(false);
  const applyChatMessagesRef = useRef<
    (value: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void
  >(() => undefined);
  const syncSessionAfterTurnRef = useRef<(sessionId: string) => Promise<void>>(async () => undefined);

  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/loop-builder/chat",
    body: () => ({ sessionId: sessionIdRef.current ?? undefined }),
  }), []);

  const commandUsage = useMemo(() => sumBuilderLiveUsage(
    ...commands.map((command) => normalizeBuilderLiveUsage(command.usage)),
  ), [commands]);

  const savedUsage = useMemo(
    () => sumBuilderLiveUsage(commandUsage, analyzerUsage),
    [analyzerUsage, commandUsage],
  );



  const fetchSessionPayload = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/loop-builder/sessions/${sessionId}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to load builder session");
    return payload;
  }, []);

  const applySessionPayload = useCallback((sessionId: string, payload: {
    commands?: unknown[];
    session?: {
      phase?: string;
      workflowId?: string | null;
      error?: { message?: string } | null;
      buildContract?: {
        requirements?: Array<{
          kind?: string;
          required?: boolean;
          status?: string;
          value?: unknown;
        }>;
      } | null;
      discoveredToolContracts?: Array<{ toolRef?: string; name?: string; constraints?: { connected?: boolean } }>;
      analyzerUsage?: unknown;
    } | null;
    recalledPreferences?: unknown;
    messages?: UIMessage[];
  }) => {
    setSessionId(sessionId);
    setCommands((payload.commands ?? []) as BuilderCommandUiSnapshot[]);
    setAnalyzerUsage(normalizeBuilderLiveUsage(payload.session?.analyzerUsage));
    setBuilderSession(payload.session ?? null);
    setRecalledPreferences(Array.isArray(payload.recalledPreferences) ? payload.recalledPreferences as Array<{ id: string; text: string; category?: string | null }> : []);
    notifyLoopBuilderSessionUpdated(sessionId);
  }, []);

  const hydrateSessionMessages = useCallback((payload: {
    messages?: UIMessage[];
    commands?: unknown[];
  }) => hydrateBuilderMessagesFromCommands(
    payload.messages as UIMessage[],
    (payload.commands ?? []) as Parameters<typeof hydrateBuilderMessagesFromCommands>[1],
  ), []);

  const refreshSession = useCallback(async (sessionId: string) => {
    const payload = await fetchSessionPayload(sessionId);
    applySessionPayload(sessionId, payload);
    return hydrateSessionMessages(payload);
  }, [applySessionPayload, fetchSessionPayload, hydrateSessionMessages]);

  const { messages, sendMessage, setMessages, status, stop, addToolApprovalResponse, addToolOutput } = useChat({
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
      if (part.type === "data-usage" && "data" in part) {
        setLiveUsageFromStream(normalizeBuilderLiveUsage(part.data));
        return;
      }
      if (part.type !== "data-session") return;
      const nextId = (part.data as { sessionId?: string }).sessionId;
      if (!nextId || nextId === sessionId) return;
      setSessionId(nextId);
      window.history.replaceState(null, "", `/dashboard/loops/new?session=${encodeURIComponent(nextId)}`);
    },
    onFinish: () => {
      setLiveUsageFromStream(null);
      const id = sessionIdRef.current;
      if (!id) return;
      skipPersistRef.current = true;
      void syncSessionAfterTurnRef.current(id)
        .catch((err) => {
          console.error("[loop-builder] failed to refresh session after turn:", err);
        });
    },
  });

  const applyChatMessages = useCallback(
    (value: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
      setMessages((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        if (next === prev) return prev;
        return dedupeChatMessagesById(next);
      });
    },
    [setMessages],
  );
  applyChatMessagesRef.current = applyChatMessages;

  const syncSessionAfterTurn = useCallback(async (sessionId: string) => {
    const mergeCommandsIntoLiveMessages = (commands: unknown[]) => {
      applyChatMessagesRef.current((prev) => hydrateBuilderMessagesFromCommands(
        prev,
        commands as Parameters<typeof hydrateBuilderMessagesFromCommands>[1],
      ));
    };

    const loadAndApply = async () => {
      const payload = await fetchSessionPayload(sessionId);
      applySessionPayload(sessionId, payload);
      return payload;
    };

    const payload = await loadAndApply();
    mergeCommandsIntoLiveMessages(payload.commands ?? []);

    // Backend command persistence can trail stream end — re-fetch commands once.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const freshPayload = await loadAndApply();
    if (JSON.stringify(freshPayload.commands) !== JSON.stringify(payload.commands)) {
      mergeCommandsIntoLiveMessages(freshPayload.commands ?? []);
    }

    window.setTimeout(() => {
      skipPersistRef.current = false;
    }, 0);
  }, [applySessionPayload, fetchSessionPayload]);
  syncSessionAfterTurnRef.current = syncSessionAfterTurn;

  const transcriptMessages = useMemo(
    () => filterBuilderTranscriptMessages(messages),
    [messages],
  );

  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") return message.id;
    }
    return null;
  }, [messages]);
  transcriptMessagesRef.current = transcriptMessages;

  const liveUsage = (status === "streaming" || status === "submitted") && liveUsageFromStream
    ? liveUsageFromStream
    : savedUsage;

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session");
    if (!sessionId) return;
    hydratingRef.current = true;
    const timer = window.setTimeout(() => {
      refreshSession(sessionId)
        .then((loaded) => {
          skipPersistRef.current = true;
          applyChatMessages(loaded);
        })
        .catch((err) => {
          console.error("[loop-builder] failed to load session:", err);
        })
        .finally(() => {
          hydratingRef.current = false;
          window.setTimeout(() => {
            skipPersistRef.current = false;
          }, 0);
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [applyChatMessages, refreshSession]);

  useEffect(() => {
    if (!sessionId) return;

    const persistOnExit = () => {
      const id = sessionIdRef.current;
      const snapshot = transcriptMessagesRef.current;
      if (!id || skipPersistRef.current || hydratingRef.current || snapshot.length === 0) return;
      void persistBuilderMessages(id, snapshot, { keepalive: true }).catch((error) => {
        console.error("[loop-builder] failed to persist messages on exit:", error);
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persistOnExit();
    };

    window.addEventListener("pagehide", persistOnExit);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", persistOnExit);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      persistOnExit();
    };
  }, [sessionId]);

  useEffect(() => {
    const next = detectBuilderRecoveryState({
      messages: transcriptMessages,
      commands,
      chatStatus: status,
      sessionPhase: builderSession?.phase,
      sessionError: builderSession?.error?.message ?? null,
      buildContract: builderSession?.buildContract ?? null,
    });
    setRecoveryState((prev) => (
      prev.kind === next.kind
      && ("message" in prev ? prev.message : undefined) === ("message" in next ? next.message : undefined)
      && ("commandId" in prev ? prev.commandId : undefined) === ("commandId" in next ? next.commandId : undefined)
      && ("toolName" in prev ? prev.toolName : undefined) === ("toolName" in next ? next.toolName : undefined)
        ? prev
        : next
    ));
  }, [builderSession?.buildContract, builderSession?.phase, builderSession?.error?.message, commands, status, transcriptMessages]);

  useEffect(() => {
    if (recoveryState.kind !== "interrupted") {
      recoveryPrefillKeyRef.current = null;
      return;
    }

    const prompt = latestUserPromptText(messages);
    if (!prompt) return;
    const key = `${messages.at(-1)?.id ?? "tail"}:${prompt}`;
    if (recoveryPrefillKeyRef.current === key) return;
    if (composerText.trim()) return;

    recoveryPrefillKeyRef.current = key;
    setComposerText(prompt);
  }, [composerText, messages, recoveryState.kind]);

  const activeInteractivePrompt = findActiveInteractivePrompt(messages);
  const activeAppSelection = findActiveAppSelection(messages);
  const activeConnectorSetup = findActiveConnectorSetup(messages);
  const activeScheduleSetup = findActiveScheduleSetup(messages);
  const activeKnowledgeBaseSetup = findActiveKnowledgeBaseSetup(messages);
  const activeArtifactSetup = findActiveArtifactSetup(messages);
  const activeRequirementSetup = findActiveRequirementSetup(messages);

  const artifactDraftTemplates = useMemo(
    () => (activeArtifactSetup?.input as {
      draftTemplates?: Array<{
        templateId: EmailTemplateId;
        name?: string;
        props?: Partial<EmailTemplateProps>;
      }>;
    } | undefined)?.draftTemplates,
    [activeArtifactSetup?.input],
  );

  useEffect(() => {
    setAppSelectionUiReady(false);
  }, [activeAppSelection?.toolCallId]);

  const connectedSearchToolkits = useMemo(() => {
    const contracts = builderSession?.discoveredToolContracts ?? [];
    const seen = new Set<string>();
    const toolkits: Array<{ toolkit: string; name: string; connected: boolean }> = [];
    for (const contract of contracts) {
      const toolRef = typeof contract.toolRef === "string" ? contract.toolRef : "";
      const match = toolRef.match(/^composio\.([^.]+)\.search$/i);
      if (!match?.[1]) continue;
      const toolkit = match[1].toLowerCase();
      if (seen.has(toolkit)) continue;
      seen.add(toolkit);
      toolkits.push({
        toolkit,
        name: typeof contract.name === "string" ? contract.name : `${toolkit} search`,
        connected: contract.constraints?.connected === true,
      });
    }
    return toolkits;
  }, [builderSession]);
  const activePromptId = activeInteractivePrompt?.toolCallId ?? null;
  const activeSetupId = activeRequirementSetup?.toolCallId ?? null;
  const showInteractivePrompt = activePromptId !== null && activePromptId !== dismissedPromptId;
  const showRequirementSetup = activeSetupId !== null && activeSetupId !== dismissedSetupId;
  const composerInteractiveReady = status === "ready";
  const runningBackendCommand = useMemo(
    () => findRunningBuilderCommand(commands),
    [commands],
  );
  const backendCommandRunning = recoveryState.kind === "running" || Boolean(runningBackendCommand);
  const backendBusyLabel = builderRunningCommandLabel(runningBackendCommand);
  const chatTurnInFlight = status === "streaming" || status === "submitted";
  const composerBusy = chatTurnInFlight || backendCommandRunning;
  const hasComposerGate = composerInteractiveReady && Boolean(
    activeAppSelection
    || (activeConnectorSetup && sessionId)
    || activeKnowledgeBaseSetup
    || activeArtifactSetup
    || (activeScheduleSetup && sessionId)
    || showRequirementSetup
    || showInteractivePrompt,
  );
  const showBuilderThinking = useMemo(
    () => shouldShowBuilderThinking({ status, messages, hasComposerGate }),
    [hasComposerGate, messages, status],
  );
  const showComposerDots = composerBusy;
  const showTranscriptDots = showBuilderThinking && !composerBusy;
  const submitComposerText = useCallback(async (text: string) => {
    const answerText = text.trim();
    if (!answerText) return;

    if (activeRequirementSetup?.state === "input-available" && activeSetupId === dismissedSetupId) {
      const setupMessageIndex = messages.findIndex((message) =>
        message.parts.some((part) =>
          isToolUIPart(part) && part.toolCallId === activeRequirementSetup.toolCallId
        )
      );
      const requirementId = String((activeRequirementSetup.input as { requirementId?: string } | undefined)?.requirementId ?? "");
      if (setupMessageIndex >= 0 && requirementId) {
        const answer: RequirementSetupOutput = {
          requirementId,
          selectedOptionIds: [],
          selectedValues: [],
          otherText: answerText,
          answerText,
        };
        const answeredMessages = messages.slice(0, setupMessageIndex + 1).map((message, messageIndex) =>
          messageIndex === setupMessageIndex
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  isToolUIPart(part) && part.toolCallId === activeRequirementSetup.toolCallId
                    ? { ...part, state: "output-available", output: answer } as ToolPart
                    : part
                ),
              }
            : message
        );
        applyChatMessages([
          ...answeredMessages,
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: answerText }],
          },
        ]);
        await sendMessage();
        return;
      }
    }

    if (activeInteractivePrompt?.state === "input-available" && activePromptId === dismissedPromptId) {
      const promptMessageIndex = messages.findIndex((message) =>
        message.parts.some((part) =>
          isToolUIPart(part) && part.toolCallId === activeInteractivePrompt.toolCallId
        )
      );
      if (promptMessageIndex >= 0) {
        const answer = {
          selectedOptionIds: [],
          selectedValues: [],
          otherText: answerText,
          answerText,
        } satisfies InteractivePromptAnswer;
        const answeredPromptMessages = messages.slice(0, promptMessageIndex + 1).map((message, messageIndex) =>
          messageIndex === promptMessageIndex
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  isToolUIPart(part) && part.toolCallId === activeInteractivePrompt.toolCallId
                    ? { ...part, state: "output-available", output: answer } as ToolPart
                    : part
                ),
              }
            : message
        );
        applyChatMessages([
          ...answeredPromptMessages,
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: answerText }],
          },
        ]);
        await sendMessage();
        return;
      }
    }

    await sendMessage({ text: answerText });
  }, [activeInteractivePrompt, activePromptId, activeRequirementSetup, activeSetupId, applyChatMessages, dismissedPromptId, dismissedSetupId, messages, sendMessage]);

  return (
    <div className="relative flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden bg-white">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[400px] bg-gradient-to-t from-slate-100 to-transparent" />
      <div className="relative z-10 flex h-full flex-col overflow-hidden">
        <Conversation>
            <ConversationContent className="mx-auto max-w-3xl gap-8 p-4">
              <ScrollOnToolComplete messages={transcriptMessages} />

              {transcriptMessages.length === 0 && !sessionId && (
                <LoopSuggestionCards
                  className="max-w-3xl"
                  onSelect={submitComposerText}
                />
              )}
              {transcriptMessages.map((message) => {
                const specDraftSpawnPartIndex = lastSpecDraftSpawnPartIndex(message.parts);
                const assistantStreamActive = (status === "streaming" || status === "submitted")
                  && message.role === "assistant"
                  && message.id === latestAssistantMessageId;
                return (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <TranscriptMessageContent
                      message={message}
                      expandReasoning={false}
                      isStreaming={assistantStreamActive}
                      shouldRenderText={(ctx) => shouldRenderBuilderTranscriptText({
                        ...ctx,
                        isStreaming: assistantStreamActive,
                      })}
                      renderTool={(part, toolName, index) => {
                        if (part.state === "output-error") {
                          return <IssueNotice key={index} />;
                        }
                        if (toolName === "appSelection") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as {
                            question?: string;
                            recommendedToolkitSlugs?: string[];
                            allowMultiple?: boolean;
                          } : {};
                          const output = part.output && typeof part.output === "object" ? part.output as AppSelectionOutput : null;
                          return output ? (
                            <BuilderAppSelector
                              allowMultiple={input.allowMultiple ?? true}
                              completedOutput={output}
                              key={index}
                              question={input.question ?? "What app is where your customers reach out to you for support?"}
                              recommendedToolkitSlugs={input.recommendedToolkitSlugs ?? []}
                            />
                          ) : null;
                        }
                        if (toolName === "interactivePrompt") {
                          // Stream the prompt only in the composer input area.
                          // In the transcript, show only submitted/completed states.
                          if (part.state === "input-streaming" || part.state === "input-available") {
                            return null;
                          }
                          return (
                            <InteractivePromptTool
                              disabled
                              key={index}
                              onSubmit={() => undefined}
                              part={part}
                            />
                          );
                        }
                        if (toolName === "connectorSetup") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as { requirementId?: string } : {};
                          return sessionId && input.requirementId
                            ? <BuilderConnectorChecklist completed key={index} requirementId={input.requirementId} sessionId={sessionId} />
                            : null;
                        }
                        if (toolName === "scheduleSetup") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as {
                            requirementId?: string;
                            question?: string;
                            subtitle?: string;
                            options?: Array<{
                              id: string;
                              label: string;
                              description?: string;
                              trigger?: "schedule" | "event";
                              cron?: string;
                              timezone?: string;
                              toolkit?: string;
                              triggerSlug?: string;
                            }>;
                            recommendedOptionIds?: string[];
                            allowOther?: boolean;
                          } : {};
                          const output = part.output && typeof part.output === "object" ? part.output as ScheduleSelectionOutput : null;
                          return sessionId && output ? <BuilderScheduleSelector
                            allowOther={input.allowOther}
                            completedOutput={output}
                            key={index}
                            options={input.options}
                            question={input.question}
                            recommendedOptionIds={input.recommendedOptionIds}
                            requirementId={input.requirementId ?? "trigger_schedule"}
                            sessionId={sessionId}
                            subtitle={input.subtitle}
                          /> : null;
                        }
                        if (toolName === "knowledgeBaseSetup") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as { requirementId?: string } : {};
                          const output = part.output && typeof part.output === "object" ? part.output as KnowledgeBaseSelectionOutput : null;
                          return output ? <BuilderKnowledgeBaseSelector
                            completedOutput={output}
                            connectedSearchToolkits={connectedSearchToolkits}
                            key={index}
                            recalledPreferences={recalledPreferences}
                            requirementId={input.requirementId ?? "grounding"}
                          /> : null;
                        }
                        if (toolName === "artifactSetup") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as { requirementId?: string } : {};
                          const output = part.output && typeof part.output === "object" ? part.output as ArtifactSetupOutput : null;
                          return output ? <BuilderArtifactEditor
                            completedOutput={output}
                            key={index}
                            messages={messages}
                            onSave={(next) => applyChatMessages((current) => updateArtifactToolOutput(current, part.toolCallId, next))}
                            requirementId={input.requirementId ?? "artifact_contract"}
                            sessionId={sessionId ?? undefined}
                            toolCallId={part.toolCallId}
                          /> : null;
                        }
                        if (toolName === "requirementSetup") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          const input = part.input && typeof part.input === "object" ? part.input as {
                            requirementId?: string;
                            question?: string;
                            options?: InteractivePromptOption[];
                            recommendedOptionIds?: string[];
                            allowMultiple?: boolean;
                            allowOther?: boolean;
                          } : {};
                          const output = part.output && typeof part.output === "object" ? part.output as RequirementSetupOutput : null;
                          return output && input.question && input.options ? (
                            <BuilderRequirementSelector
                              completedOutput={output}
                              key={index}
                              options={input.options}
                              placement="transcript"
                              question={input.question}
                              recommendedOptionIds={input.recommendedOptionIds}
                              allowMultiple={input.allowMultiple}
                              allowOther={input.allowOther}
                              requirementId={input.requirementId ?? output.requirementId}
                            />
                          ) : null;
                        }
                        if (toolName === "resolveBuildRequirement" || toolName === "refreshConnectorAvailability") return null;
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
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: false })} variant="outline" className="border-[#d1d5db] text-[#6b7280] hover:bg-[#fafafa]">Reject</ConfirmationAction>
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })} className="bg-[#111827] text-white hover:opacity-85">Approve</ConfirmationAction>
                              </ConfirmationActions>
                            </Confirmation>
                          );
                        }
                        if (toolName === "getAvailableTools" && part.state === "output-available") {
                          return <AvailableTools key={index} part={part} />;
                        }
                        if (toolName === "saveLoop" && !isSpecDraftSpawnTool(toolName, part)) {
                          return null;
                        }
                        if (toolName === "runBuilderTest") {
                          return (
                            <BuilderTestRunPanel
                              commands={commands}
                              key={index}
                              part={part}
                            />
                          );
                        }
                        if (isSpecDraftSpawnTool(toolName, part) && index === specDraftSpawnPartIndex) {
                          return (
                            <BuilderAgentSpawnPanel
                              commands={commands}
                              key={index}
                              part={part}
                            />
                          );
                        }
                        if (isSpecDraftSpawnTool(toolName, part)) {
                          return null;
                        }
                        return undefined;
                      }}
                    />
                  </MessageContent>
                </Message>
              );
              })}
              {showTranscriptDots ? (
                <Message from="assistant">
                  <MessageContent>
                    <TranscriptThinkingIndicator />
                  </MessageContent>
                </Message>
              ) : null}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <motion.div
              className="relative overflow-hidden border border-[#d1d5db] bg-white transition-colors focus-within:border-[#9ca3af]"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {composerInteractiveReady && activeAppSelection ? (
                  <motion.div
                    key="app-selection"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {!appSelectionUiReady ? (
                      <div className="px-4 py-5 flex min-h-[56px] items-center">
                        <TranscriptThinkingIndicator variant="shimmer" label="Loading app options…" />
                      </div>
                    ) : null}
                    <div className={appSelectionUiReady ? undefined : "hidden"} aria-hidden={!appSelectionUiReady}>
                      <BuilderAppSelector
                        allowMultiple={Boolean((activeAppSelection.input as { allowMultiple?: boolean } | undefined)?.allowMultiple ?? true)}
                        onComplete={(output) => addToolOutput({
                          tool: "appSelection",
                          toolCallId: activeAppSelection.toolCallId,
                          output,
                        })}
                        onReadyChange={setAppSelectionUiReady}
                        question={String((activeAppSelection.input as { question?: string } | undefined)?.question ?? "What app is where your customers reach out to you for support?")}
                        recommendedToolkitSlugs={(activeAppSelection.input as { recommendedToolkitSlugs?: string[] } | undefined)?.recommendedToolkitSlugs ?? []}
                      />
                    </div>
                  </motion.div>
                ) : composerInteractiveReady && activeConnectorSetup && sessionId ? (
                  <motion.div
                    key="connector-setup"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <BuilderConnectorChecklist
                      onComplete={(output) => addToolOutput({
                        tool: "connectorSetup",
                        toolCallId: activeConnectorSetup.toolCallId,
                        output,
                      })}
                      requirementId={String((activeConnectorSetup.input as { requirementId?: string } | undefined)?.requirementId ?? "connector_selection")}
                      sessionId={sessionId}
                    />
                  </motion.div>
                ) : composerInteractiveReady && activeKnowledgeBaseSetup ? (
                  <motion.div
                    key="knowledge-base-setup"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <BuilderKnowledgeBaseSelector
                      connectedSearchToolkits={connectedSearchToolkits}
                      onComplete={(output) => addToolOutput({
                        tool: "knowledgeBaseSetup",
                        toolCallId: activeKnowledgeBaseSetup.toolCallId,
                        output,
                      })}
                      recalledPreferences={recalledPreferences}
                      requirementId={String((activeKnowledgeBaseSetup.input as { requirementId?: string } | undefined)?.requirementId ?? "grounding")}
                    />
                  </motion.div>
                ) : composerInteractiveReady && activeArtifactSetup ? (
                  <motion.div
                    key="artifact-setup"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <BuilderArtifactEditor
                      draftTemplates={artifactDraftTemplates}
                      inputReady={activeArtifactSetup.state === "input-available"}
                      onComplete={(output) => addToolOutput({
                        tool: "artifactSetup",
                        toolCallId: activeArtifactSetup.toolCallId,
                        output,
                      })}
                      requirementId={String((activeArtifactSetup.input as { requirementId?: string } | undefined)?.requirementId ?? "artifact_contract")}
                      sessionId={sessionId ?? undefined}
                    />
                  </motion.div>
                ) : composerInteractiveReady && activeScheduleSetup && sessionId ? (
                  <motion.div
                    key="schedule-setup"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <BuilderScheduleSelector
                      allowOther={(activeScheduleSetup.input as { allowOther?: boolean } | undefined)?.allowOther}
                      onComplete={(output) => addToolOutput({
                        tool: "scheduleSetup",
                        toolCallId: activeScheduleSetup.toolCallId,
                        output,
                      })}
                      options={(activeScheduleSetup.input as {
                        options?: Array<{
                          id: string;
                          label: string;
                          description?: string;
                          trigger?: "schedule" | "event";
                          cron?: string;
                          timezone?: string;
                          toolkit?: string;
                          triggerSlug?: string;
                        }>;
                      } | undefined)?.options}
                      question={String((activeScheduleSetup.input as { question?: string } | undefined)?.question ?? "How often should this loop run?")}
                      recommendedOptionIds={(activeScheduleSetup.input as { recommendedOptionIds?: string[] } | undefined)?.recommendedOptionIds}
                      requirementId={String((activeScheduleSetup.input as { requirementId?: string } | undefined)?.requirementId ?? "trigger_schedule")}
                      sessionId={sessionId}
                      subtitle={(activeScheduleSetup.input as { subtitle?: string } | undefined)?.subtitle}
                    />
                  </motion.div>
                ) : composerInteractiveReady && showRequirementSetup ? (
                  <motion.div
                    key="requirement-setup"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <RequirementSetupTool
                      disabled={status !== "ready"}
                      onDismiss={() => setDismissedSetupId(activeRequirementSetup!.toolCallId)}
                      onSubmit={(output) => addToolOutput({
                        tool: "requirementSetup",
                        toolCallId: activeRequirementSetup!.toolCallId,
                        output,
                      })}
                      part={activeRequirementSetup!}
                      placement="composer"
                    />
                  </motion.div>
                ) : composerInteractiveReady && showInteractivePrompt ? (
                  <motion.div
                    key="interactive-prompt"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <InteractivePromptTool
                      disabled={status !== "ready"}
                      onDismiss={() => setDismissedPromptId(activeInteractivePrompt!.toolCallId)}
                      onSubmit={(answer) => addToolOutput({
                        tool: "interactivePrompt",
                        toolCallId: activeInteractivePrompt!.toolCallId,
                        output: answer,
                      })}
                      part={activeInteractivePrompt!}
                      placement="composer"
                    />
                  </motion.div>
                ) : showComposerDots ? (
                  <motion.div
                    key="composer-busy"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div
                      aria-label={backendCommandRunning ? backendBusyLabel : "Thinking"}
                      className="flex min-h-[56px] items-center px-4 py-5"
                      role="status"
                    >
                      <TranscriptThinkingIndicator />
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="prompt-input"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                  <PromptInput
                    className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0"
                    onSubmit={async ({ text }) => {
                      await submitComposerText(text);
                      setComposerText("");
                    }}
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
                        <DropdownMenuContent align="start" className="w-56 p-2 border border-[#d1d5db] bg-white">
                          <DropdownMenuItem className="gap-3 px-3 py-2 text-[14px]">
                            <Paperclip size={18} className="text-slate-700" />
                            <span>Add photos & files</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-500 hover:bg-slate-200 hover:text-slate-700 transition-colors">
                            <Activity size={14} className="text-slate-600" />
                            <span>Cost: ${liveUsage.estimatedCostUsd.toFixed(4)}</span>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="top" align="start" className="w-64 p-3 border border-[#d1d5db] mb-2 bg-white">
                          <div className="space-y-2">
                            <h4 className="font-medium leading-none text-slate-900">Live Token Usage</h4>
                            <div className="text-sm text-slate-500">
                              <div className="flex justify-between">
                                <span>Prompt:</span>
                                <span className="font-medium text-slate-700">{liveUsage.promptTokens.toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>Completion:</span>
                                <span className="font-medium text-slate-700">{liveUsage.completionTokens.toLocaleString()}</span>
                              </div>
                              <div className="mt-1 flex justify-between border-t pt-1">
                                <span>Total:</span>
                                <span className="font-medium text-slate-700">{liveUsage.totalTokens.toLocaleString()}</span>
                              </div>
                              <div className="mt-1 flex justify-between">
                                <span>Cost:</span>
                                <span className="font-medium text-slate-700">${liveUsage.estimatedCostUsd.toFixed(4)}</span>
                              </div>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>

                    <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                      <PromptInputSubmit onStop={stop} status={status} className="bg-[#111827] text-white hover:opacity-85" />
                    </PromptInputFooter>
                  </PromptInput>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-1 pb-4 text-center text-[11px] text-[#999]">
          <p>Tallei can make mistakes. Check important info.</p>
        </div>
      </div>
    </div>
  );
}

function InteractivePromptTool({
  part,
  disabled,
  onSubmit,
  onDismiss,
  placement,
}: {
  part: ToolPart;
  disabled: boolean;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  onDismiss?: () => void;
  placement?: "transcript" | "composer";
}) {
  if (part.state === "input-streaming") {
    const input = part.input && typeof part.input === "object" ? part.input as {
      question?: string;
      options?: InteractivePromptOption[];
    } : {};
    const options = input.options ?? [];
    return (
      <div className={cn(
        "w-full overflow-hidden bg-[#f9f8fc]",
        placement === "composer"
          ? "border-0"
          : "my-3 border border-[#e8e5f0]",
      )}>
        <div className="flex items-center gap-2 px-4 pb-2 pt-4 text-sm font-medium">
          <span>{input.question ?? "Analyzing your request"}</span>
          <span className="inline-flex gap-0.5">
            <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "0ms" }} />
            <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "150ms" }} />
            <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "300ms" }} />
          </span>
        </div>
        {options.length > 0 && (
          <div className="space-y-1 px-2 pb-3">
            {options.map((option, optionIndex) => (
              <div
                key={option.id ?? `option-${optionIndex}`}
                className="flex animate-in fade-in slide-in-from-bottom-1 items-start gap-3 px-2.5 py-2"
                style={{ animationDuration: "300ms" }}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-[#e8e5f0] bg-white overflow-hidden">
                  {option.icon ? (
                    <img
                      alt={option.label ?? ""}
                      className="size-5 object-contain"
                      draggable={false}
                      src={`https://logos.composio.dev/api/${option.icon}`}
                    />
                  ) : (
                    <span className="text-[11px] text-[#8a86a0]">
                      {(option.label ?? "?").charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                <span className="text-sm text-muted-foreground">{option.label ?? ""}</span>
              </div>
            ))}
            <div className="flex animate-pulse items-start gap-3 px-2.5 py-2">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-[#e8e5f0] bg-white text-[11px] text-[#8a86a0]/30">
                <span className="h-4 w-4 bg-[#e8e5f0]" />
              </span>
              <span className="h-4 w-32 bg-[#e8e5f0]" />
            </div>
          </div>
        )}
      </div>
    );
  }
  const input = part.input && typeof part.input === "object" ? part.input as {
    question?: string;
    options?: InteractivePromptOption[];
    recommendedOptionIds?: string[];
    allowMultiple?: boolean;
    allowOther?: boolean;
  } : {};
  const output = part.state === "output-available" && part.output && typeof part.output === "object"
    ? part.output as InteractivePromptAnswer
    : undefined;
  return (
    <InteractivePromptMenu
      allowMultiple={input.allowMultiple}
      allowOther={input.allowOther}
      disabled={disabled || part.state !== "input-available"}
      onDismiss={onDismiss}
      onSubmit={onSubmit}
      options={input.options ?? []}
      placement={placement}
      question={input.question ?? "Choose an option"}
      recommendedOptionIds={input.recommendedOptionIds}
      submittedAnswer={output}
    />
  );
}

function ScrollOnToolComplete({ messages }: { messages: UIMessage[] }) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  const completedToolIdsRef = useRef<Set<string>>(new Set());
  const lastMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    let shouldScroll = false;

    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.id ?? null;
    if (lastMessageId && lastMessageId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = lastMessageId;
      shouldScroll = true;
    }

    for (const part of messages.flatMap((message) => message.parts)) {
      if (!isToolUIPart(part) || part.state !== "output-available" || !("toolCallId" in part)) continue;
      if (completedToolIdsRef.current.has(part.toolCallId)) continue;
      completedToolIdsRef.current.add(part.toolCallId);
      shouldScroll = true;
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

function findActiveInteractivePrompt(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "interactivePrompt"
        && isBuilderToolInputReady(part)) {
        return part;
      }
    }
  }
  return null;
}

function findActiveAppSelection(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "appSelection"
        && isBuilderToolInputReady(part)) {
        return part;
      }
    }
  }
  return null;
}

function findActiveConnectorSetup(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "connectorSetup"
        && isBuilderToolInputReady(part)) {
        return part;
      }
    }
  }
  return null;
}

function findActiveKnowledgeBaseSetup(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "knowledgeBaseSetup"
        && isBuilderToolInputReady(part)) return part;
    }
  }
  return null;
}

function findActiveScheduleSetup(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "scheduleSetup"
        && isBuilderToolInputReady(part)) return part;
    }
  }
  return null;
}

function findActiveArtifactSetup(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "artifactSetup"
        && isBuilderToolInputReady(part)) return part;
    }
  }
  return null;
}

function findActiveRequirementSetup(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "requirementSetup"
        && isBuilderToolInputReady(part)) return part;
    }
  }
  return null;
}

function RequirementSetupTool({
  part,
  disabled,
  onSubmit,
  onDismiss,
  placement,
}: {
  part: ToolPart;
  disabled: boolean;
  onSubmit: (output: RequirementSetupOutput) => void;
  onDismiss?: () => void;
  placement?: "transcript" | "composer";
}) {
  if (part.state === "input-streaming") {
    return <InteractivePromptTool disabled onSubmit={() => undefined} part={part} placement={placement} />;
  }
  const input = part.input && typeof part.input === "object" ? part.input as {
    requirementId?: string;
    question?: string;
    options?: InteractivePromptOption[];
    recommendedOptionIds?: string[];
    allowMultiple?: boolean;
    allowOther?: boolean;
  } : {};
  if (!input.question || !input.options?.length || !input.requirementId) return null;
  return (
    <BuilderRequirementSelector
      allowMultiple={input.allowMultiple}
      allowOther={input.allowOther ?? true}
      disabled={disabled}
      onComplete={onSubmit}
      onDismiss={onDismiss}
      options={input.options}
      placement={placement}
      question={input.question}
      recommendedOptionIds={input.recommendedOptionIds}
      requirementId={input.requirementId}
    />
  );
}

function AvailableTools({ part }: { part: ToolPart }) {
  const output = part.output && typeof part.output === "object" ? part.output as { tools?: Array<{
    name?: string;
    description?: string;
    connected?: boolean;
    risk?: string | null;
  }> } : {};
  return (
    <CollapsibleTool part={part}>
      {part.type === "dynamic-tool"
        ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <div className="space-y-2">
          {(output.tools ?? []).length === 0 && <p className="text-sm text-muted-foreground">No external connector actions are required.</p>}
          {(output.tools ?? []).map((item, index) => (
            <div className="border border-[#e5e7eb] p-3 text-sm" key={`${item.name}-${index}`}>
              <div className="font-medium">{item.name ?? "Available tool"}</div>
              <div className="text-muted-foreground">{item.description}</div>
              <div className="mt-1 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                {item.connected ? "Connected" : "Connection required"} · Risk: {item.risk ?? "unknown"}
              </div>
            </div>
          ))}
        </div>
      </ToolContent>
    </CollapsibleTool>
  );
}

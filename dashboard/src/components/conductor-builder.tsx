"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import { ConductorBuilderLayout } from "@/components/conductor/conductor-builder-layout";
import { useConductorLayout } from "@/components/conductor/conductor-layout-context";
import type { LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";
import {
  ConductorChatProvider,
  useConductorChat,
  type ConductorChatApi,
} from "@/components/conductor/conductor-chat-context";
import {
  clearPhaseProgressPendingUiTool,
  findConductorStall,
  findPendingInteractivePrompts,
  findPendingOutcomeBrief,
  findStaleConfirmOutcomeBriefCalls,
  hasUnansweredUiToolCalls,
  isConductorBudgetExhausted,
  makeUserMessage,
  prepareMessagesForUiToolOutput,
  resolveConfirmOutcomeBriefActionFromSelection,
  messagesUiStateRevision,
  messagesPersistenceRevision,
  shouldAutoSendConductorChat,
  tryResolveContinueAsPendingUiToolAnswer,
  validateConductorComposerMessage,
  resolveToolPartName,
  type PendingInteractivePrompt,
  type ChatStatus,
  type ConductorBuildPhase,
  type PhaseHandoffProgress,
} from "@/components/conductor/conductor-shared";
import { useConductorContinuation } from "@/components/conductor/use-conductor-continuation";
import type { InteractivePromptAnswer } from "@/components/ai-elements/interactive-prompt-menu";
import { apiFetch, getStoredWorkspaceId } from "@/lib/api-fetch";
import {
  debugConductorClientTiming,
  startConductorClientTimer,
} from "@/lib/conductor-client-timing";
import { formatApiError } from "@/lib/format-api-error";
import {
  deriveConductorPromptSuggestions,
  deriveConductorPromptSuggestionsQuestion,
  findPendingPresentReplyOptions,
} from "@/lib/conductor-prompt-suggestions";
import { deriveConductorTranscriptError } from "@/lib/conductor-transcript-error";
import { isBuildTerminalForStall } from "@tallei/shared/conductor-stall-recovery";
import {
  IDLE_CONTINUATION_INTENT,
  parseContinuationIntent,
  type ConductorContinuationIntent,
} from "@/lib/conductor-continuation-intent";
import {
  deriveConductorSessionUsage,
  emptyBuilderLiveUsage,
  maxBuilderLiveUsage,
  normalizeBuilderLiveUsage,
} from "@/lib/loop-builder-usage";

type ConductorChatBridgeProps = {
  loopId: string;
  pendingPrompt: string | null;
  skipLoopFetch?: boolean;
  bootstrapPromptSentRef: MutableRefObject<boolean>;
  buildPhase: ConductorBuildPhase | null;
  phaseProgress: PhaseHandoffProgress | null;
  latestPhaseTurn: {
    phase?: string;
    parentArtifactHash?: string;
    continuation?: string;
    nextPhase?: string;
    handoffId?: string;
    pendingToolCallId?: string;
    resumeAfterAnswer?: boolean;
  } | null;
  missingSlots: string[];
  loopStatus: string;
  continuationIntent: ConductorContinuationIntent;
  onLoopMetaChange: (meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
    eventTrigger?: LoopEventTriggerStatus | null;
    buildPhase?: ConductorBuildPhase | null;
    phaseProgress?: PhaseHandoffProgress | null;
    latestPhaseTurn?: {
      phase?: string;
      parentArtifactHash?: string;
      continuation?: string;
      nextPhase?: string;
      handoffId?: string;
      pendingToolCallId?: string;
      resumeAfterAnswer?: boolean;
      outcome?: string;
      resolutionReason?: string;
      stepsUsed?: number;
    } | null;
    continuationIntent?: ConductorContinuationIntent;
  }) => void;
  children: React.ReactNode;
};

function ConductorChatBridge({
  loopId,
  pendingPrompt,
  skipLoopFetch = false,
  bootstrapPromptSentRef,
  buildPhase,
  phaseProgress,
  latestPhaseTurn,
  missingSlots,
  loopStatus,
  continuationIntent,
  onLoopMetaChange,
  children,
}: ConductorChatBridgeProps) {
  const onLoopMetaChangeRef = useRef(onLoopMetaChange);
  const buildPhaseRef = useRef(buildPhase);
  const phaseProgressRef = useRef(phaseProgress);
  const latestPhaseTurnRef = useRef<{
    phase?: string;
    parentArtifactHash?: string;
    continuation?: string;
    nextPhase?: string;
    handoffId?: string;
    pendingToolCallId?: string;
    resumeAfterAnswer?: boolean;
  } | null>(null);
  const missingSlotsRef = useRef(missingSlots);
  const loopStatusRef = useRef(loopStatus);
  const continuationIntentRef = useRef(continuationIntent);

  useEffect(() => { onLoopMetaChangeRef.current = onLoopMetaChange; }, [onLoopMetaChange]);
  useEffect(() => { buildPhaseRef.current = buildPhase; }, [buildPhase]);
  useEffect(() => { phaseProgressRef.current = phaseProgress; }, [phaseProgress]);
  useEffect(() => { latestPhaseTurnRef.current = latestPhaseTurn; }, [latestPhaseTurn]);
  useEffect(() => { missingSlotsRef.current = missingSlots; }, [missingSlots]);
  useEffect(() => { loopStatusRef.current = loopStatus; }, [loopStatus]);
  useEffect(() => { continuationIntentRef.current = continuationIntent; }, [continuationIntent]);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/loops/${loopId}/chat`,
      headers: (): Record<string, string> => {
        const ws = getStoredWorkspaceId();
        return ws ? { "X-Workspace-Id": ws } : {};
      },
    }),
    [loopId],
  );

  const [streamUsage, setStreamUsage] = useState<ReturnType<typeof normalizeBuilderLiveUsage> | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [optimisticallyResolvedToolCallIds, setOptimisticallyResolvedToolCallIds] = useState<Set<string>>(
    () => new Set(),
  );

  const {
    messages,
    sendMessage,
    status: chatStatus,
    addToolOutput,
    regenerate,
    setMessages,
    stop,
  } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages }) => {
      // Only continue if the user has performed a real in-session action (chip answer,
      // typed message). This ref is never set on page hydration, so refresh is safe.
      if (!sessionActionRef.current) return false;
      return shouldAutoSendConductorChat({
        messages,
        buildPhase: buildPhaseRef.current,
        phaseProgress: phaseProgressRef.current,
        missingSlots: missingSlotsRef.current,
        loopStatus: loopStatusRef.current,
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Conductor could not finish that response. Your message was saved — try again.";
      console.error("[conductor/chat] stream failed:", error);
      setChatError(message);
      toast.error(message);
    },
    onData: (part) => {
      if (part.type === "data-usage" && "data" in part) {
        setStreamUsage((current) => maxBuilderLiveUsage(
          current,
          normalizeBuilderLiveUsage(part.data),
        ));
      }
      if (part.type === "data-conductor-error" && "data" in part) {
        const data = part.data as { message?: string };
        if (typeof data.message === "string" && data.message.trim()) {
          setChatError(data.message.trim());
        }
      }
    },
  });

  const messageUsage = useMemo(() => deriveConductorSessionUsage(messages), [messages]);
  const isStreaming = chatStatus === "streaming" || chatStatus === "submitted";
  const chatUsage = useMemo(
    () => (isStreaming && streamUsage
      ? maxBuilderLiveUsage(messageUsage, streamUsage)
      : messageUsage),
    [isStreaming, messageUsage, streamUsage],
  );

  useEffect(() => {
    if (chatStatus === "ready") {
      setStreamUsage(null);
    }
  }, [chatStatus]);

  const chatLoadedRef = useRef(false);
  const prevChatStatusRef = useRef(chatStatus);
  const lastPersistedRevisionRef = useRef("");
  const lastMetaRefreshAtRef = useRef(0);
  const metaRefreshInFlightRef = useRef(false);
  const [hydrationReady, setHydrationReady] = useState(false);
  // Set to true by any real in-session user action. Never set during hydration, so
  // sendAutomaticallyWhen and the continuation hook are both safe on page refresh.
  const sessionActionRef = useRef(false);
  const processedToolMetaRef = useRef<Set<string>>(new Set());
  const supersededConfirmRef = useRef<Set<string>>(new Set());
  const answeredToolResumeRef = useRef<Set<string>>(new Set());
  const messagesRevision = messagesUiStateRevision(messages);

  const continueChat = useCallback(() => {
    void sendMessage();
  }, [sendMessage]);

  useConductorContinuation({
    continuationIntent,
    chatStatus: chatStatus as ChatStatus,
    hydrationReady,
    sessionActionRef,
    sendMessage: continueChat,
  });

  const chatApi = useMemo<ConductorChatApi>(
    () => ({
      sendMessage: (input) => {
        setChatError(null);
        sessionActionRef.current = true;
        if (input?.text) {
          void sendMessage({ text: input.text });
        } else {
          void sendMessage();
        }
      },
      regenerate,
      stop,
      addToolOutput: (params) => {
        const answerKey = `${buildPhaseRef.current ?? "unknown"}:${latestPhaseTurnRef.current?.parentArtifactHash ?? "unknown"}:${params.toolCallId}`;
        if (answeredToolResumeRef.current.has(answerKey)) return Promise.resolve();
        answeredToolResumeRef.current.add(answerKey);
        // Mark as in-session action BEFORE patching messages so sendAutomaticallyWhen
        // sees the flag when it evaluates after the state update.
        sessionActionRef.current = true;
        flushSync(() => {
          setOptimisticallyResolvedToolCallIds((current) => {
            if (current.has(params.toolCallId)) return current;
            const next = new Set(current);
            next.add(params.toolCallId);
            return next;
          });
          setMessages((current) => prepareMessagesForUiToolOutput(
            current,
            params.toolCallId,
            params.output,
          ));
          const clearedPhaseProgress = clearPhaseProgressPendingUiTool(
            phaseProgressRef.current,
            params.toolCallId,
          );
          if (clearedPhaseProgress !== phaseProgressRef.current) {
            phaseProgressRef.current = clearedPhaseProgress ?? null;
            onLoopMetaChangeRef.current({
              phaseProgress: clearedPhaseProgress ?? null,
            });
          }
        });
        return Promise.resolve(addToolOutput({
          tool: params.tool,
          toolCallId: params.toolCallId,
          output: params.output,
          // sendAutomaticallyWhen handles the POST; no direct sendMessage() call here.
        })).catch((error) => {
          answeredToolResumeRef.current.delete(answerKey);
          setOptimisticallyResolvedToolCallIds((current) => {
            if (!current.has(params.toolCallId)) return current;
            const next = new Set(current);
            next.delete(params.toolCallId);
            return next;
          });
          throw error;
        });
      },
    }),
    [addToolOutput, regenerate, sendMessage, setMessages, stop],
  );

  useEffect(() => {
    setOptimisticallyResolvedToolCallIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const part of message.parts ?? []) {
          const toolPart = part as { toolCallId?: string; state?: string; output?: unknown };
          if (!toolPart.toolCallId || !next.has(toolPart.toolCallId)) continue;
          if (toolPart.state === "output-available" && toolPart.output != null) {
            next.delete(toolPart.toolCallId);
          }
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [messagesRevision]);

  const chatContextValue = {
    messages,
    chatStatus: chatStatus as ChatStatus,
    chatApi,
    chatUsage,
    chatError,
    optimisticallyResolvedToolCallIds,
  };

  useEffect(() => {
    chatLoadedRef.current = false;
    setHydrationReady(false);
    setStreamUsage(null);
    sessionActionRef.current = false;
    processedToolMetaRef.current = new Set();
    supersededConfirmRef.current = new Set();
    answeredToolResumeRef.current = new Set();
    setOptimisticallyResolvedToolCallIds(new Set());

    if (skipLoopFetch) {
      chatLoadedRef.current = true;
      setHydrationReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const elapsed = startConductorClientTimer();
      const res = await apiFetch(`/api/loops/${loopId}`);
      const data = await res.json();
      if (cancelled) return;
      if (res.ok) {
        const hydratedStatus = data.loop?.status ?? "draft";
        const hydratedBuildPhase = typeof data.buildProgress?.internalPhase === "string"
          ? data.buildProgress.internalPhase as ConductorBuildPhase
          : null;
        const hydratedPhaseProgress = data.buildProgress?.phaseProgress ?? null;
        const hydratedLatestPhaseTurn = data.buildProgress?.latestPhaseTurn ?? null;
        const hydratedContinuationIntent = parseContinuationIntent(data.buildProgress?.continuationIntent);

        loopStatusRef.current = hydratedStatus;
        buildPhaseRef.current = hydratedBuildPhase;
        phaseProgressRef.current = hydratedPhaseProgress;
        latestPhaseTurnRef.current = hydratedLatestPhaseTurn;
        continuationIntentRef.current = hydratedContinuationIntent;

        onLoopMetaChangeRef.current({
          loopName: typeof data.loop?.name === "string" ? data.loop.name : undefined,
          spec: data.spec ?? null,
          missingSlots: Array.isArray(data.missingSlots) ? data.missingSlots : [],
          status: hydratedStatus,
          compiledPlanId: data.buildChat?.compiledPlanId ?? null,
          eventTrigger: data.eventTrigger ?? null,
          buildPhase: hydratedBuildPhase,
          phaseProgress: hydratedPhaseProgress,
          latestPhaseTurn: hydratedLatestPhaseTurn,
          continuationIntent: hydratedContinuationIntent,
        });
        if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) {
          setMessages(data.chatMessages as UIMessage[]);
          lastPersistedRevisionRef.current = messagesPersistenceRevision(data.chatMessages as UIMessage[]);
        }
        chatLoadedRef.current = true;
        setHydrationReady(true);
        debugConductorClientTiming(`hydrate:${loopId}`, { totalMs: elapsed() });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loopId, setMessages, skipLoopFetch]);

  useEffect(() => {
    if (!chatLoadedRef.current || bootstrapPromptSentRef.current || !pendingPrompt?.trim()) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    if (messages.some((message) => message.role === "user")) {
      bootstrapPromptSentRef.current = true;
      return;
    }
    bootstrapPromptSentRef.current = true;
    sessionActionRef.current = true;
    void sendMessage({ text: pendingPrompt.trim() });
  }, [bootstrapPromptSentRef, chatStatus, messages, pendingPrompt, sendMessage]);

  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        const metaKey = `${message.id}:${"toolCallId" in part ? String(part.toolCallId) : part.type}`;
        const phaseToolPart = part as { type: string; state?: string; output?: unknown };
        if (phaseToolPart.type.startsWith("tool-") && phaseToolPart.state === "output-available") {
          const output = phaseToolPart.output as {
            spec?: Record<string, unknown>;
            missingSlots?: string[];
            phaseAfter?: ConductorBuildPhase;
          };
          if (output.spec || output.missingSlots || output.phaseAfter) {
            const specMetaKey = `${metaKey}:spec`;
            if (processedToolMetaRef.current.has(specMetaKey)) continue;
            processedToolMetaRef.current.add(specMetaKey);
            onLoopMetaChangeRef.current({
              ...(output.spec ? { spec: output.spec } : {}),
              ...(output.missingSlots ? { missingSlots: output.missingSlots } : {}),
              ...(output.phaseAfter ? { buildPhase: output.phaseAfter } : {}),
            });
          }
        }
        if (resolveToolPartName(phaseToolPart) === "compileLoop" && phaseToolPart.state === "output-available") {
          if (processedToolMetaRef.current.has(metaKey)) continue;
          processedToolMetaRef.current.add(metaKey);
          const output = phaseToolPart.output as { ok?: boolean; plan?: { id: string } };
          if (output.ok && output.plan?.id) {
            onLoopMetaChangeRef.current({ compiledPlanId: output.plan.id });
          }
        }
        if (resolveToolPartName(phaseToolPart) === "activateLoop" && phaseToolPart.state === "output-available") {
          if (processedToolMetaRef.current.has(metaKey)) continue;
          processedToolMetaRef.current.add(metaKey);
          const output = phaseToolPart.output as {
            ok?: boolean;
            status?: string;
            eventTrigger?: LoopEventTriggerStatus;
            alreadyActive?: boolean;
            turnOutcome?: string;
          };
          if (output.ok || output.alreadyActive || output.turnOutcome === "build_complete") {
            onLoopMetaChangeRef.current({
              status: output.status ?? "active",
              eventTrigger: output.eventTrigger ?? null,
            });
          }
        }
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!chatApi || chatStatus === "streaming" || chatStatus === "submitted") return;
    for (const stale of findStaleConfirmOutcomeBriefCalls(messages)) {
      if (supersededConfirmRef.current.has(stale.toolCallId)) continue;
      supersededConfirmRef.current.add(stale.toolCallId);
      void chatApi.addToolOutput({
        tool: "confirmOutcomeBrief",
        toolCallId: stale.toolCallId,
        output: {
          action: "other",
          briefHash: stale.briefHash,
          otherText: "Superseded by updated outcome brief",
        },
      });
    }
  }, [chatApi, chatStatus, messages]);

  useEffect(() => {
    if (!chatLoadedRef.current || messages.length === 0) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    const persistenceRevision = messagesPersistenceRevision(messages);
    if (persistenceRevision === lastPersistedRevisionRef.current) return;
    const timer = window.setTimeout(() => {
      const elapsed = startConductorClientTimer();
      void apiFetch(`/api/loops/${loopId}/chat`, {
        method: "PUT",
        body: JSON.stringify({ messages }),
      }).then(() => {
        lastPersistedRevisionRef.current = persistenceRevision;
        debugConductorClientTiming(`chat-put:${loopId}`, { totalMs: elapsed() });
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [messages, chatStatus, loopId]);

  useEffect(() => {
    const previousStatus = prevChatStatusRef.current;
    prevChatStatusRef.current = chatStatus;
    if (!chatLoadedRef.current || chatStatus === "streaming" || chatStatus === "submitted") return;
    const streamJustFinished = (previousStatus === "streaming" || previousStatus === "submitted")
      && chatStatus === "ready";
    if (!streamJustFinished) return;
    // Prevent the chat PUT effect from racing bookkeeping: the stream transcript may
    // lack a server-injected pickConnectorApp that finalize just persisted.
    lastPersistedRevisionRef.current = messagesPersistenceRevision(messages);
    const now = Date.now();
    if (now - lastMetaRefreshAtRef.current < 2_000) return;
    if (metaRefreshInFlightRef.current) return;
    let cancelled = false;
    metaRefreshInFlightRef.current = true;
    void (async () => {
      const elapsed = startConductorClientTimer();
      const res = await apiFetch(`/api/loops/${loopId}`);
      const data = await res.json();
      if (cancelled || !res.ok) return;
      onLoopMetaChangeRef.current({
        status: typeof data.loop?.status === "string" ? data.loop.status : undefined,
        buildPhase: typeof data.buildProgress?.internalPhase === "string"
          ? data.buildProgress.internalPhase as ConductorBuildPhase
          : null,
        phaseProgress: data.buildProgress?.phaseProgress ?? null,
        latestPhaseTurn: data.buildProgress?.latestPhaseTurn ?? null,
        continuationIntent: parseContinuationIntent(data.buildProgress?.continuationIntent),
      });
      // Bookkeeping may inject a server-owned pickConnectorApp after a reasoning-only
      // stall; sync the transcript so the picker mounts without requiring a full refresh.
      if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) {
        const nextMessages = data.chatMessages as UIMessage[];
        setMessages(nextMessages);
        lastPersistedRevisionRef.current = messagesPersistenceRevision(nextMessages);
      }
      lastMetaRefreshAtRef.current = Date.now();
      debugConductorClientTiming(`meta-refresh:${loopId}`, { totalMs: elapsed() });
    })().finally(() => {
      metaRefreshInFlightRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [chatStatus, loopId, setMessages]);

  return (
    <ConductorChatProvider value={chatContextValue}>
      {children}
    </ConductorChatProvider>
  );
}

function ConductorBuilderLive({
  loopId,
  loopName,
  spec,
  missingSlots,
  buildPhase,
  phaseProgress,
  latestPhaseTurn,
  continuationIntent,
  compiledPlanId,
  status,
  eventTrigger,
  input,
  setInput,
  creating,
  pendingUserBubble,
  setPendingUserBubble,
  onCreateLoop,
  onRun,
}: {
  loopId: string | null;
  loopName?: string;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  buildPhase: ConductorBuildPhase | null;
  phaseProgress: PhaseHandoffProgress | null;
  latestPhaseTurn: {
    outcome?: string;
    resolutionReason?: string;
    continuation?: string;
    stepsUsed?: number;
  } | null;
  continuationIntent: ConductorContinuationIntent;
  compiledPlanId: string | null;
  status: string;
  eventTrigger: LoopEventTriggerStatus | null;
  input: string;
  setInput: (value: string) => void;
  creating: boolean;
  pendingUserBubble: UIMessage | null;
  setPendingUserBubble: (message: UIMessage | null) => void;
  onCreateLoop: (text: string, meta?: { loopName?: string }) => void | Promise<void>;
  onRun?: () => void;
}) {
  const liveChat = useConductorChat();
  const messages = useMemo(
    () => liveChat?.messages ?? (pendingUserBubble ? [pendingUserBubble] : []),
    [liveChat?.messages, pendingUserBubble],
  );
  const optimisticallyResolvedToolCallIds = liveChat?.optimisticallyResolvedToolCallIds ?? new Set<string>();
  const chatUsage = liveChat?.chatUsage ?? emptyBuilderLiveUsage();
  const chatStatus: ChatStatus = creating
    ? "submitted"
    : liveChat?.chatStatus ?? "ready";
  const chatApi = liveChat?.chatApi ?? null;
  const chatError = liveChat?.chatError ?? null;

  const pendingQuestions = useMemo(
    () => findPendingInteractivePrompts(messages, spec, phaseProgress, optimisticallyResolvedToolCallIds),
    [messages, spec, phaseProgress, optimisticallyResolvedToolCallIds],
  );
  const pendingOutcomeBrief = useMemo(
    () => findPendingOutcomeBrief(messages, phaseProgress),
    [messages, phaseProgress],
  );
  const pendingReplyOptions = useMemo(
    () => findPendingPresentReplyOptions(messages),
    [messages],
  );

  const chatBusy = creating || chatStatus === "streaming" || chatStatus === "submitted";
  const [longRunningThinking, setLongRunningThinking] = useState(false);

  useEffect(() => {
    if (!chatBusy) {
      setLongRunningThinking(false);
      return;
    }
    const timer = window.setTimeout(() => setLongRunningThinking(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [chatBusy]);

  const isStalled = useMemo(
    () => findConductorStall({
      messages,
      buildPhase,
      missingSlots,
      chatBusy,
      loopStatus: status,
      phaseProgress,
    }).stalled,
    [messages, buildPhase, missingSlots, chatBusy, status, phaseProgress],
  );

  const budgetExhausted = useMemo(
    () => isConductorBudgetExhausted(messages),
    [messages],
  );

  const buildTerminal = useMemo(
    () => isBuildTerminalForStall({ loopStatus: status, phaseProgress }),
    [status, phaseProgress],
  );

  const transcriptError = useMemo(
    () => deriveConductorTranscriptError({
      messages,
      chatStatus,
      streamError: chatError,
      phaseProgress,
      loopStatus: status,
      latestPhaseTurn,
      continuationIntent,
      hasPendingQuestion: Boolean(pendingQuestions.length || pendingOutcomeBrief),
    }),
    [
      messages,
      chatStatus,
      chatError,
      phaseProgress,
      status,
      latestPhaseTurn,
      continuationIntent,
      pendingQuestions.length,
      pendingOutcomeBrief,
    ],
  );

  const promptSuggestionsQuestion = useMemo(
    () => deriveConductorPromptSuggestionsQuestion(messages, isStalled, budgetExhausted, buildTerminal),
    [messages, isStalled, budgetExhausted, buildTerminal],
  );

  const promptSuggestions = useMemo(
    () => deriveConductorPromptSuggestions({
      messages,
      missingSlots,
      status,
      buildPhase,
      isStalled,
      budgetExhausted,
      phaseProgress,
      hasPendingQuestion: Boolean(pendingQuestions.length || pendingOutcomeBrief),
      hasPendingReplyOptions: Boolean(pendingReplyOptions),
      chatBusy,
      explicitOptions: pendingReplyOptions?.input.options,
    }),
    [
      buildPhase,
      chatBusy,
      isStalled,
      budgetExhausted,
      messages,
      missingSlots,
      pendingQuestions,
      pendingOutcomeBrief,
      pendingReplyOptions,
      phaseProgress,
      status,
    ],
  );

  useEffect(() => {
    if (messages.some((message) => message.role === "user")) {
      setPendingUserBubble(null);
    }
  }, [messages, setPendingUserBubble]);

  function handleSubmit(text: string, meta?: { loopName?: string }) {
    if (creating) return;
    const validationError = validateConductorComposerMessage(text);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const pendingUiResolution = tryResolveContinueAsPendingUiToolAnswer(text, phaseProgress);
    if (pendingUiResolution && chatApi) {
      void chatApi.addToolOutput(pendingUiResolution);
      return;
    }
    if (hasUnansweredUiToolCalls(messages, phaseProgress)) {
      toast.error("Answer the pending question before sending a message.");
      return;
    }
    if (!loopId) {
      onCreateLoop(text, meta);
      return;
    }
    chatApi?.sendMessage({ text: text.trim() });
  }

  function submitAskQuestionAnswer(prompt: PendingInteractivePrompt, answer: InteractivePromptAnswer) {
    if (!chatApi) return;
    void chatApi.addToolOutput({
      tool: prompt.toolName,
      toolCallId: prompt.toolCallId,
      output: {
        questionId: prompt.input.questionId,
        answerText: answer.answerText,
        selectedOptionIds: answer.selectedOptionIds,
        selectedValues: answer.selectedValues,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        ...(prompt.input.outcomeId ? { outcomeId: prompt.input.outcomeId } : {}),
        ...(prompt.input.role ? { role: prompt.input.role } : {}),
      },
    });
  }

  function dismissAskQuestion(prompt: PendingInteractivePrompt) {
    if (!chatApi) return;
    void chatApi.addToolOutput({
      tool: prompt.toolName,
      toolCallId: prompt.toolCallId,
      output: {
        questionId: prompt.input.questionId,
        answerText: "skipped",
        selectedOptionIds: [],
        selectedValues: [],
        skipped: true,
        ...(prompt.input.outcomeId ? { outcomeId: prompt.input.outcomeId } : {}),
        ...(prompt.input.role ? { role: prompt.input.role } : {}),
      },
    });
  }

  function submitOutcomeBriefAnswer(answer: InteractivePromptAnswer) {
    if (!pendingOutcomeBrief || !chatApi) return;
    const action = resolveConfirmOutcomeBriefActionFromSelection({
      selectedOptionIds: answer.selectedOptionIds,
      selectedValues: answer.selectedValues,
      options: pendingOutcomeBrief.confirmPrompt.options,
    });
    void chatApi.addToolOutput({
      tool: "confirmOutcomeBrief",
      toolCallId: pendingOutcomeBrief.toolCallId,
      output: {
        action,
        briefHash: pendingOutcomeBrief.confirmBriefHash,
        answerText: answer.answerText,
        selectedOptionIds: answer.selectedOptionIds,
        selectedValues: answer.selectedValues,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
      },
    });
  }

  function handlePromptSuggestionsSubmit(answer: InteractivePromptAnswer) {
    if (creating || chatStatus === "streaming" || chatStatus === "submitted") return;

    const message = answer.answerText.trim();
    if (!message) return;
    const validationError = validateConductorComposerMessage(message);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    if (pendingReplyOptions && chatApi) {
      const selectedOptionId = answer.selectedOptionIds[0] ?? "custom";
      void chatApi.addToolOutput({
        tool: "presentReplyOptions",
        toolCallId: pendingReplyOptions.toolCallId,
        output: {
          selectedOptionId,
          message,
        },
      });
      return;
    }

    const pendingUiResolution = tryResolveContinueAsPendingUiToolAnswer(message, phaseProgress);
    if (pendingUiResolution && chatApi) {
      void chatApi.addToolOutput(pendingUiResolution);
      return;
    }

    if (hasUnansweredUiToolCalls(messages, phaseProgress)) {
      toast.error("Answer the pending question before sending a message.");
      return;
    }

    if (!loopId) {
      onCreateLoop(message);
      return;
    }
    chatApi?.sendMessage({ text: message });
  }

  return (
    <ConductorBuilderLayout
      loopId={loopId ?? undefined}
      loopName={loopName}
      messages={messages}
      chatStatus={chatStatus}
      input={input}
      setInput={setInput}
      onSubmit={handleSubmit}
      onStop={() => chatApi?.stop()}
      onRetry={() => { void chatApi?.regenerate(); }}
      pendingQuestions={pendingQuestions}
      pendingOutcomeBrief={pendingOutcomeBrief}
      pendingReplyOptionsCallId={pendingReplyOptions?.toolCallId ?? null}
      promptSuggestions={promptSuggestions}
      promptSuggestionsQuestion={promptSuggestionsQuestion}
      onAskQuestionAnswer={submitAskQuestionAnswer}
      onAskQuestionDismiss={dismissAskQuestion}
      onOutcomeBriefAnswer={submitOutcomeBriefAnswer}
      onPromptSuggestionsSubmit={handlePromptSuggestionsSubmit}
      spec={spec}
      missingSlots={missingSlots}
      status={status}
      compiledPlanId={compiledPlanId}
      eventTrigger={eventTrigger}
      onRun={onRun}
      thinkingLabel={creating ? "Creating loop…" : longRunningThinking ? "Still working…" : "Thinking…"}
      forceThinking={creating}
      composerDisabled={creating}
      sendBlocked={hasUnansweredUiToolCalls(messages, phaseProgress)}
      chatUsage={chatUsage}
      transcriptError={transcriptError}
    />
  );
}

function ConductorBuilderSession({ initialLoopId }: { initialLoopId?: string }) {
  const setLoopMeta = useConductorLayout()?.setLoopMeta;
  const resetLoopMeta = useConductorLayout()?.resetLoopMeta;
  const registerHandlers = useConductorLayout()?.registerHandlers;
  const [loopId, setLoopId] = useState<string | null>(initialLoopId ?? null);
  const [loopName, setLoopName] = useState<string | undefined>();
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [missingSlots, setMissingSlots] = useState<string[]>([]);
  const [compiledPlanId, setCompiledPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [buildPhase, setBuildPhase] = useState<ConductorBuildPhase | null>(null);
  const [phaseProgress, setPhaseProgress] = useState<PhaseHandoffProgress | null>(null);
  const [latestPhaseTurn, setLatestPhaseTurn] = useState<{
    phase?: string;
    parentArtifactHash?: string;
    continuation?: string;
    nextPhase?: string;
    handoffId?: string;
    pendingToolCallId?: string;
    resumeAfterAnswer?: boolean;
    outcome?: string;
    resolutionReason?: string;
    stepsUsed?: number;
  } | null>(null);
  const [continuationIntent, setContinuationIntent] = useState<ConductorContinuationIntent>(IDLE_CONTINUATION_INTENT);
  const [eventTrigger, setEventTrigger] = useState<LoopEventTriggerStatus | null>(null);
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingUserBubble, setPendingUserBubble] = useState<UIMessage | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrapPromptSentRef = useRef(false);
  const createdInSessionRef = useRef(false);

  const handleLoopMetaChange = useCallback((meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
    eventTrigger?: LoopEventTriggerStatus | null;
    buildPhase?: ConductorBuildPhase | null;
    phaseProgress?: PhaseHandoffProgress | null;
    latestPhaseTurn?: {
      phase?: string;
      parentArtifactHash?: string;
      continuation?: string;
      nextPhase?: string;
      handoffId?: string;
      pendingToolCallId?: string;
      resumeAfterAnswer?: boolean;
      outcome?: string;
      resolutionReason?: string;
      stepsUsed?: number;
    } | null;
    continuationIntent?: ConductorContinuationIntent;
  }) => {
    if (meta.loopName !== undefined) setLoopName(meta.loopName);
    if (meta.spec !== undefined) {
      setSpec((prev) => {
        const next = meta.spec ?? null;
        if (prev === next) return prev;
        if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    }
    if (meta.missingSlots !== undefined) {
      setMissingSlots((prev) => (
        prev.length === meta.missingSlots!.length
        && prev.every((slot, index) => slot === meta.missingSlots![index])
          ? prev
          : meta.missingSlots!
      ));
    }
    if (meta.status !== undefined) setStatus((prev) => (prev === meta.status ? prev : meta.status!));
    if (meta.buildPhase !== undefined) {
      setBuildPhase((prev) => (prev === meta.buildPhase ? prev : meta.buildPhase ?? null));
    }
    if (meta.phaseProgress !== undefined) {
      setPhaseProgress((prev) => {
        const next = meta.phaseProgress ?? null;
        if (prev === next) return prev;
        if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    }
    if (meta.latestPhaseTurn !== undefined) {
      setLatestPhaseTurn((prev) => {
        const next = meta.latestPhaseTurn ?? null;
        if (prev === next) return prev;
        if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    }
    if (meta.continuationIntent !== undefined) {
      setContinuationIntent((prev) => {
        const next = meta.continuationIntent ?? IDLE_CONTINUATION_INTENT;
        if (prev.action === next.action
          && prev.reason === next.reason
          && prev.trigger === next.trigger
          && prev.handoffId === next.handoffId) {
          return prev;
        }
        return next;
      });
    }
    if (meta.compiledPlanId !== undefined) {
      setCompiledPlanId((prev) => (prev === meta.compiledPlanId ? prev : meta.compiledPlanId ?? null));
    }
    if (meta.eventTrigger !== undefined) {
      setEventTrigger((prev) => {
        const next = meta.eventTrigger ?? null;
        if (prev === next) return prev;
        if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (initialLoopId) return;
    resetLoopMeta?.();
    setLoopName(undefined);
  }, [initialLoopId, resetLoopMeta]);

  useEffect(() => {
    registerHandlers?.({ onLoopNameChange: setLoopName });
  }, [registerHandlers]);

  useEffect(() => {
    setLoopMeta?.({
      loopId: loopId ?? undefined,
      loopName,
      status,
    });
  }, [setLoopMeta, loopId, loopName, status]);

  async function createLoopFromPrompt(text: string, meta?: { loopName?: string }) {
    const validationError = validateConductorComposerMessage(text);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setPendingUserBubble(makeUserMessage(text));
    setCreating(true);
    pendingPromptRef.current = text;
    bootstrapPromptSentRef.current = false;
    try {
      const res = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({
          prompt: text,
          ...((meta?.loopName ?? loopName)?.trim()
            ? { name: (meta?.loopName ?? loopName)!.trim() }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(formatApiError(data, "Failed to create loop"));
      const createdId = data.loop?.id as string | undefined;
      if (!createdId) throw new Error("Failed to create loop");

      createdInSessionRef.current = true;
      setLoopName(typeof data.loop?.name === "string" ? data.loop.name : undefined);
      setSpec(data.spec ?? null);
      setLoopId(createdId);
      window.history.replaceState(null, "", `/dashboard/loops/${createdId}/conductor`);
    } catch (error) {
      pendingPromptRef.current = null;
      bootstrapPromptSentRef.current = false;
      setPendingUserBubble(null);
      toast.error(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setCreating(false);
    }
  }

  async function handleRun() {
    if (!loopId) return;
    const res = await apiFetch(`/api/loops/${loopId}/runs`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) toast.error(formatApiError(data, "Run failed"));
    else if (data.run?.id) {
      window.location.href = `/dashboard/loops/${loopId}/runs/${data.run.id}`;
    }
  }

  const liveProps = {
    loopId,
    loopName,
    spec,
    missingSlots,
    buildPhase,
    phaseProgress,
    latestPhaseTurn,
    continuationIntent,
    compiledPlanId,
    status,
    eventTrigger,
    input,
    setInput,
    creating,
    pendingUserBubble,
    setPendingUserBubble,
    onCreateLoop: createLoopFromPrompt,
    onRun: loopId ? () => void handleRun() : undefined,
  };

  const live = <ConductorBuilderLive {...liveProps} />;

  if (!loopId) return live;

  return (
    <ConductorChatBridge
      loopId={loopId}
      pendingPrompt={pendingPromptRef.current}
      skipLoopFetch={createdInSessionRef.current}
      bootstrapPromptSentRef={bootstrapPromptSentRef}
      buildPhase={buildPhase}
      phaseProgress={phaseProgress}
      latestPhaseTurn={latestPhaseTurn}
      missingSlots={missingSlots}
      loopStatus={status}
      continuationIntent={continuationIntent}
      onLoopMetaChange={handleLoopMetaChange}
    >
      {live}
    </ConductorChatBridge>
  );
}

export function ConductorBuilder({ loopId: initialLoopId }: { loopId?: string }) {
  return <ConductorBuilderSession initialLoopId={initialLoopId} />;
}

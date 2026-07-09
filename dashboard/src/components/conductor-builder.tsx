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
  findPendingInteractivePrompts,
  findPendingOutcomeBrief,
  findStaleConfirmOutcomeBriefCalls,
  hasUnansweredUiToolCalls,
  isConductorBudgetExhausted,
  makeUserMessage,
  partitionPendingQuestionBatch,
  resolveConfirmOutcomeBriefActionFromSelection,
  messagesUiStateRevision,
  messagesPersistenceRevision,
  tryResolveContinueAsPendingUiToolAnswer,
  validateConductorComposerMessage,
  resolveToolPartName,
  type PendingInteractivePrompt,
  type ChatStatus,
  type ConductorBuildPhase,
  type PhaseHandoffProgress,
} from "@/components/conductor/conductor-shared";
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
import { submitConductorToolAnswer } from "@/lib/conductor-tool-answer";
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
    regenerate,
    setMessages,
    stop,
  } = useChat({
    transport,
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
  const lastSyncedRevisionRef = useRef("");
  const lastMetaRefreshAtRef = useRef(0);
  const metaRefreshInFlightRef = useRef(false);
  const [toolAnswerBusy, setToolAnswerBusy] = useState(false);
  const inFlightToolAnswersRef = useRef<Set<string>>(new Set());
  const processedToolMetaRef = useRef<Set<string>>(new Set());
  const supersededConfirmRef = useRef<Set<string>>(new Set());
  const messagesRevision = messagesUiStateRevision(messages);

  const chatApi = useMemo<ConductorChatApi>(
    () => ({
      sendMessage: (input) => {
        setChatError(null);
        if (!input?.text?.trim()) return;
        void sendMessage({ text: input.text });
      },
      regenerate,
      stop,
      answerTool: async (params) => {
        const answerKey = `${params.toolCallId}`;
        if (inFlightToolAnswersRef.current.has(answerKey)) return;
        inFlightToolAnswersRef.current.add(answerKey);
        setChatError(null);
        setToolAnswerBusy(true);
        flushSync(() => {
          setOptimisticallyResolvedToolCallIds((current) => {
            if (current.has(params.toolCallId)) return current;
            const next = new Set(current);
            next.add(params.toolCallId);
            return next;
          });
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
        try {
          await submitConductorToolAnswer({
            loopId,
            tool: params.tool,
            toolCallId: params.toolCallId,
            output: params.output,
            onMeta: (meta) => onLoopMetaChangeRef.current(meta),
            setMessages: (next) => {
              setMessages(next);
              lastSyncedRevisionRef.current = messagesPersistenceRevision(next);
            },
          });
        } catch (error) {
          setOptimisticallyResolvedToolCallIds((current) => {
            if (!current.has(params.toolCallId)) return current;
            const next = new Set(current);
            next.delete(params.toolCallId);
            return next;
          });
          const message = error instanceof Error ? error.message : "Could not submit that answer.";
          setChatError(message);
          toast.error(message);
          throw error;
        } finally {
          inFlightToolAnswersRef.current.delete(answerKey);
          setToolAnswerBusy(false);
        }
      },
    }),
    [loopId, regenerate, sendMessage, setMessages, stop],
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
    chatStatus: (toolAnswerBusy ? "submitted" : chatStatus) as ChatStatus,
    chatApi,
    chatUsage,
    chatError,
    optimisticallyResolvedToolCallIds,
  };

  useEffect(() => {
    chatLoadedRef.current = false;
    setStreamUsage(null);
    processedToolMetaRef.current = new Set();
    supersededConfirmRef.current = new Set();
    inFlightToolAnswersRef.current = new Set();
    setOptimisticallyResolvedToolCallIds(new Set());

    if (skipLoopFetch) {
      chatLoadedRef.current = true;
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
          lastSyncedRevisionRef.current = messagesPersistenceRevision(data.chatMessages as UIMessage[]);
        }
        chatLoadedRef.current = true;
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
    if (!chatApi || chatStatus === "streaming" || chatStatus === "submitted" || toolAnswerBusy) return;
    for (const stale of findStaleConfirmOutcomeBriefCalls(messages)) {
      if (supersededConfirmRef.current.has(stale.toolCallId)) continue;
      if (optimisticallyResolvedToolCallIds.has(stale.toolCallId)) continue;
      if (inFlightToolAnswersRef.current.has(stale.toolCallId)) continue;
      supersededConfirmRef.current.add(stale.toolCallId);
      void chatApi.answerTool({
        tool: "confirmOutcomeBrief",
        toolCallId: stale.toolCallId,
        output: {
          action: "other",
          briefHash: stale.briefHash,
          otherText: "Superseded by updated outcome brief",
        },
      });
    }
  }, [chatApi, chatStatus, messages, optimisticallyResolvedToolCallIds, toolAnswerBusy]);

  useEffect(() => {
    const previousStatus = prevChatStatusRef.current;
    prevChatStatusRef.current = chatStatus;
    if (!chatLoadedRef.current || chatStatus === "streaming" || chatStatus === "submitted" || toolAnswerBusy) {
      return;
    }
    const streamJustFinished = (previousStatus === "streaming" || previousStatus === "submitted")
      && chatStatus === "ready";
    if (!streamJustFinished) return;
    const liveRevision = messagesPersistenceRevision(messages);
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
      // Only replace the live transcript when the server revision is newer. Never wipe
      // a complete in-memory assistant turn with an older/empty projection.
      if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) {
        const nextMessages = data.chatMessages as UIMessage[];
        const serverRevision = messagesPersistenceRevision(nextMessages);
        const shouldReplace = serverRevision !== liveRevision
          && (nextMessages.length >= messages.length || serverRevision !== lastSyncedRevisionRef.current);
        if (shouldReplace) {
          setMessages(nextMessages);
          lastSyncedRevisionRef.current = serverRevision;
        } else {
          lastSyncedRevisionRef.current = liveRevision;
        }
      }
      lastMetaRefreshAtRef.current = Date.now();
      debugConductorClientTiming(`meta-refresh:${loopId}`, { totalMs: elapsed() });
    })().finally(() => {
      metaRefreshInFlightRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [chatStatus, loopId, messages, setMessages, toolAnswerBusy]);

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
  const [queuedQuestionAnswers, setQueuedQuestionAnswers] = useState<
    Map<string, InteractivePromptAnswer & { skipped?: boolean }>
  >(() => new Map());
  const [submittingQuestionBatch, setSubmittingQuestionBatch] = useState(false);
  const [activeFlushBatch, setActiveFlushBatch] = useState<PendingInteractivePrompt[] | null>(null);

  const pendingQuestionIdsKey = useMemo(
    () => pendingQuestions.map((prompt) => prompt.toolCallId).join("|"),
    [pendingQuestions],
  );

  useEffect(() => {
    setQueuedQuestionAnswers(new Map());
    setSubmittingQuestionBatch(false);
    setActiveFlushBatch(null);
  }, [loopId]);

  useEffect(() => {
    setQueuedQuestionAnswers((current) => {
      if (current.size === 0) return current;
      const validIds = new Set(pendingQuestions.map((prompt) => prompt.toolCallId));
      const next = new Map<string, InteractivePromptAnswer & { skipped?: boolean }>();
      for (const [toolCallId, answer] of current) {
        if (validIds.has(toolCallId)) next.set(toolCallId, answer);
      }
      return next.size === current.size ? current : next;
    });
  }, [pendingQuestionIdsKey, pendingQuestions]);

  const questionBatch = useMemo(
    () => partitionPendingQuestionBatch(pendingQuestions, queuedQuestionAnswers),
    [pendingQuestions, queuedQuestionAnswers],
  );
  const visiblePendingQuestions = useMemo(() => {
    if (activeFlushBatch?.length) {
      const last = activeFlushBatch[activeFlushBatch.length - 1];
      return last
        ? [{
          ...last,
          input: {
            ...last.input,
            step: { index: activeFlushBatch.length, total: activeFlushBatch.length },
          },
        }]
        : [];
    }
    return questionBatch.remaining;
  }, [activeFlushBatch, questionBatch.remaining]);
  const pendingOutcomeBrief = useMemo(
    () => findPendingOutcomeBrief(messages, phaseProgress, optimisticallyResolvedToolCallIds),
    [messages, phaseProgress, optimisticallyResolvedToolCallIds],
  );
  const pendingReplyOptions = useMemo(
    () => findPendingPresentReplyOptions(messages, optimisticallyResolvedToolCallIds),
    [messages, optimisticallyResolvedToolCallIds],
  );

  const chatBusy = creating || chatStatus === "streaming" || chatStatus === "submitted";
  const questionSubmitBusy = submittingQuestionBatch
    || (!questionBatch.batchMode && chatBusy);
  const [longRunningThinking, setLongRunningThinking] = useState(false);

  useEffect(() => {
    if (!chatBusy) {
      setLongRunningThinking(false);
      return;
    }
    const timer = window.setTimeout(() => setLongRunningThinking(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [chatBusy]);

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
      hasPendingQuestion: Boolean(visiblePendingQuestions.length || pendingOutcomeBrief),
    }),
    [
      messages,
      chatStatus,
      chatError,
      phaseProgress,
      status,
      latestPhaseTurn,
      continuationIntent,
      visiblePendingQuestions.length,
      pendingOutcomeBrief,
    ],
  );

  const promptSuggestionsQuestion = useMemo(
    () => deriveConductorPromptSuggestionsQuestion(messages, budgetExhausted, buildTerminal),
    [messages, budgetExhausted, buildTerminal],
  );

  const promptSuggestions = useMemo(
    () => deriveConductorPromptSuggestions({
      messages,
      missingSlots,
      status,
      buildPhase,
      budgetExhausted,
      phaseProgress,
      hasPendingQuestion: Boolean(visiblePendingQuestions.length || pendingOutcomeBrief),
      hasPendingReplyOptions: Boolean(pendingReplyOptions),
      chatBusy,
      explicitOptions: pendingReplyOptions?.input.options,
    }),
    [
      buildPhase,
      chatBusy,
      budgetExhausted,
      messages,
      missingSlots,
      visiblePendingQuestions.length,
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
    if (pendingUiResolution) {
      if (!chatApi) {
        toast.error("Conductor is still loading. Try again in a moment.");
        return;
      }
      void chatApi.answerTool(pendingUiResolution);
      return;
    }
    if (hasUnansweredUiToolCalls(messages, phaseProgress, optimisticallyResolvedToolCallIds)) {
      toast.error("Answer the pending question before sending a message.");
      return;
    }
    if (!loopId) {
      onCreateLoop(text, meta);
      return;
    }
    chatApi?.sendMessage({ text: text.trim() });
  }

  function buildAskQuestionOutput(
    prompt: PendingInteractivePrompt,
    answer: InteractivePromptAnswer & { skipped?: boolean },
  ) {
    return {
      questionId: prompt.input.questionId,
      answerText: answer.answerText,
      selectedOptionIds: answer.selectedOptionIds,
      selectedValues: answer.selectedValues,
      ...(answer.otherText ? { otherText: answer.otherText } : {}),
      ...(answer.skipped ? { skipped: true } : {}),
      ...(prompt.input.outcomeId ? { outcomeId: prompt.input.outcomeId } : {}),
      ...(prompt.input.role ? { role: prompt.input.role } : {}),
    };
  }

  async function flushQueuedQuestionAnswers(
    batch: PendingInteractivePrompt[],
    answers: Map<string, InteractivePromptAnswer & { skipped?: boolean }>,
  ) {
    if (!chatApi || batch.length === 0) return;
    setActiveFlushBatch(batch);
    setSubmittingQuestionBatch(true);
    try {
      for (const prompt of batch) {
        const answer = answers.get(prompt.toolCallId);
        if (!answer) continue;
        await chatApi.answerTool({
          tool: prompt.toolName,
          toolCallId: prompt.toolCallId,
          output: buildAskQuestionOutput(prompt, answer),
        });
      }
      setQueuedQuestionAnswers(new Map());
    } finally {
      setActiveFlushBatch(null);
      setSubmittingQuestionBatch(false);
    }
  }

  function submitAskQuestionAnswer(prompt: PendingInteractivePrompt, answer: InteractivePromptAnswer) {
    if (!chatApi) {
      toast.error("Conductor is still loading. Try again in a moment.");
      return;
    }
    if (questionBatch.batchMode) {
      const nextQueue = new Map(queuedQuestionAnswers);
      nextQueue.set(prompt.toolCallId, answer);
      setQueuedQuestionAnswers(nextQueue);
      const allAnswered = pendingQuestions.every((item) => nextQueue.has(item.toolCallId));
      if (allAnswered) {
        void flushQueuedQuestionAnswers(pendingQuestions, nextQueue);
      }
      return;
    }
    void chatApi.answerTool({
      tool: prompt.toolName,
      toolCallId: prompt.toolCallId,
      output: buildAskQuestionOutput(prompt, answer),
    });
  }

  function dismissAskQuestion(prompt: PendingInteractivePrompt) {
    if (!chatApi) {
      toast.error("Conductor is still loading. Try again in a moment.");
      return;
    }
    const skippedAnswer: InteractivePromptAnswer & { skipped: boolean } = {
      answerText: "skipped",
      selectedOptionIds: [],
      selectedValues: [],
      skipped: true,
    };
    if (questionBatch.batchMode) {
      submitAskQuestionAnswer(prompt, skippedAnswer);
      return;
    }
    void chatApi.answerTool({
      tool: prompt.toolName,
      toolCallId: prompt.toolCallId,
      output: buildAskQuestionOutput(prompt, skippedAnswer),
    });
  }

  function submitOutcomeBriefAnswer(answer: InteractivePromptAnswer) {
    if (!chatApi) {
      toast.error("Conductor is still loading. Try again in a moment.");
      return;
    }
    if (!pendingOutcomeBrief) {
      toast.error("That confirmation is no longer pending. Refresh and try again.");
      return;
    }
    const action = resolveConfirmOutcomeBriefActionFromSelection({
      selectedOptionIds: answer.selectedOptionIds,
      selectedValues: answer.selectedValues,
      options: pendingOutcomeBrief.confirmPrompt.options,
    });
    void chatApi.answerTool({
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

    if (pendingReplyOptions) {
      if (!chatApi) {
        toast.error("Conductor is still loading. Try again in a moment.");
        return;
      }
      const selectedOptionId = answer.selectedOptionIds[0] ?? "custom";
      void chatApi.answerTool({
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
    if (pendingUiResolution) {
      if (!chatApi) {
        toast.error("Conductor is still loading. Try again in a moment.");
        return;
      }
      void chatApi.answerTool(pendingUiResolution);
      return;
    }

    if (hasUnansweredUiToolCalls(messages, phaseProgress, optimisticallyResolvedToolCallIds)) {
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
      pendingQuestions={visiblePendingQuestions}
      questionSubmitBusy={questionSubmitBusy}
      questionBatchMode={questionBatch.batchMode}
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
      sendBlocked={hasUnansweredUiToolCalls(messages, phaseProgress, optimisticallyResolvedToolCallIds)}
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

"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { ConductorBuilderLayout } from "@/components/conductor/conductor-builder-layout";
import type { LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";
import {
  ConductorChatProvider,
  useConductorChat,
  type ConductorChatApi,
} from "@/components/conductor/conductor-chat-context";
import {
  findAutoConnectorPromptTarget,
  findPendingInteractivePrompt,
  makeUserMessage,
  type ChatStatus,
} from "@/components/conductor/conductor-shared";
import type { InteractivePromptAnswer } from "@/components/ai-elements/interactive-prompt-menu";
import { apiFetch, getStoredWorkspaceId } from "@/lib/api-fetch";
import {
  deriveConductorPromptSuggestions,
  findPendingPresentReplyOptions,
  type ConductorPromptSuggestion,
} from "@/lib/conductor-prompt-suggestions";

type ConductorChatBridgeProps = {
  loopId: string;
  pendingPrompt: string | null;
  skipLoopFetch?: boolean;
  bootstrapPromptSentRef: MutableRefObject<boolean>;
  onLoopMetaChange: (meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
    eventTrigger?: LoopEventTriggerStatus | null;
  }) => void;
  children: React.ReactNode;
};

function ConductorChatBridge({
  loopId,
  pendingPrompt,
  skipLoopFetch = false,
  bootstrapPromptSentRef,
  onLoopMetaChange,
  children,
}: ConductorChatBridgeProps) {
  const onLoopMetaChangeRef = useRef(onLoopMetaChange);

  useEffect(() => { onLoopMetaChangeRef.current = onLoopMetaChange; }, [onLoopMetaChange]);

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

  const { messages, sendMessage, status: chatStatus, addToolOutput, setMessages, stop } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const chatLoadedRef = useRef(false);
  const processedToolMetaRef = useRef<Set<string>>(new Set());

  const chatApi = useMemo<ConductorChatApi>(
    () => ({ sendMessage, addToolOutput, stop }),
    [addToolOutput, sendMessage, stop],
  );

  const chatContextValue = {
    messages,
    chatStatus: chatStatus as ChatStatus,
    chatApi,
  };

  useEffect(() => {
    chatLoadedRef.current = false;
    processedToolMetaRef.current = new Set();

    if (skipLoopFetch) {
      chatLoadedRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      const res = await apiFetch(`/api/loops/${loopId}`);
      const data = await res.json();
      if (cancelled) return;
      if (res.ok) {
        onLoopMetaChangeRef.current({
          loopName: typeof data.loop?.name === "string" ? data.loop.name : undefined,
          spec: data.spec ?? null,
          missingSlots: Array.isArray(data.missingSlots) ? data.missingSlots : [],
          status: data.loop?.status ?? "draft",
          compiledPlanId: data.buildChat?.compiledPlanId ?? null,
          eventTrigger: data.eventTrigger ?? null,
        });
        if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) {
          setMessages(data.chatMessages as UIMessage[]);
        }
        chatLoadedRef.current = true;
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
        if (part.type === "tool-patchLoopSpec" && part.state === "output-available") {
          if (processedToolMetaRef.current.has(metaKey)) continue;
          processedToolMetaRef.current.add(metaKey);
          const output = part.output as { spec?: Record<string, unknown>; missingSlots?: string[] };
          onLoopMetaChangeRef.current({
            spec: output.spec ?? null,
            missingSlots: output.missingSlots,
          });
        }
        if (part.type === "tool-compileLoop" && part.state === "output-available") {
          if (processedToolMetaRef.current.has(metaKey)) continue;
          processedToolMetaRef.current.add(metaKey);
          const output = part.output as { ok?: boolean; plan?: { id: string } };
          if (output.ok && output.plan?.id) {
            onLoopMetaChangeRef.current({ compiledPlanId: output.plan.id });
          }
        }
        if (part.type === "tool-activateLoop" && part.state === "output-available") {
          if (processedToolMetaRef.current.has(metaKey)) continue;
          processedToolMetaRef.current.add(metaKey);
          const output = part.output as {
            ok?: boolean;
            status?: string;
            eventTrigger?: LoopEventTriggerStatus;
          };
          if (output.ok) {
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
    if (!chatLoadedRef.current || messages.length === 0) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    const timer = window.setTimeout(() => {
      void apiFetch(`/api/loops/${loopId}/chat`, {
        method: "PUT",
        body: JSON.stringify({ messages }),
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [messages, chatStatus, loopId]);

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
  compiledPlanId,
  status,
  eventTrigger,
  input,
  setInput,
  creating,
  pendingUserBubble,
  setPendingUserBubble,
  pendingPromptRef,
  bootstrapPromptSentRef,
  autoConnectorSubmittedRef,
  createdInSessionRef,
  onCreateLoop,
  onRun,
}: {
  loopId: string | null;
  loopName?: string;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  compiledPlanId: string | null;
  status: string;
  eventTrigger: LoopEventTriggerStatus | null;
  input: string;
  setInput: (value: string) => void;
  creating: boolean;
  pendingUserBubble: UIMessage | null;
  setPendingUserBubble: (message: UIMessage | null) => void;
  pendingPromptRef: MutableRefObject<string | null>;
  bootstrapPromptSentRef: MutableRefObject<boolean>;
  autoConnectorSubmittedRef: MutableRefObject<string | null>;
  createdInSessionRef: MutableRefObject<boolean>;
  onCreateLoop: (text: string) => void | Promise<void>;
  onRun?: () => void;
}) {
  const liveChat = useConductorChat();
  const messages = liveChat?.messages ?? (pendingUserBubble ? [pendingUserBubble] : []);
  const chatStatus: ChatStatus = creating
    ? "submitted"
    : liveChat?.chatStatus ?? "ready";
  const chatApi = liveChat?.chatApi ?? null;

  const pendingQuestion = useMemo(
    () => findPendingInteractivePrompt(messages, spec),
    [messages, spec],
  );
  const pendingReplyOptions = useMemo(
    () => findPendingPresentReplyOptions(messages),
    [messages],
  );

  const promptSuggestions = useMemo(
    () => deriveConductorPromptSuggestions({
      messages,
      missingSlots,
      status,
      hasPendingQuestion: Boolean(pendingQuestion),
      hasPendingReplyOptions: Boolean(pendingReplyOptions),
      chatBusy: creating || chatStatus === "streaming" || chatStatus === "submitted",
      explicitOptions: pendingReplyOptions?.input.options,
    }),
    [
      creating,
      chatStatus,
      messages,
      missingSlots,
      pendingQuestion,
      pendingReplyOptions,
      status,
    ],
  );

  useEffect(() => {
    if (messages.some((message) => message.role === "user")) {
      setPendingUserBubble(null);
    }
  }, [messages, setPendingUserBubble]);

  useEffect(() => {
    if (!chatApi || creating) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;

    const target = findAutoConnectorPromptTarget(messages, spec);
    if (!target) return;

    const key = `${target.toolCallId}:${target.autoConnector}`;
    if (autoConnectorSubmittedRef.current === key) return;
    autoConnectorSubmittedRef.current = key;

    void chatApi.addToolOutput({
      tool: target.toolName,
      toolCallId: target.toolCallId,
      output: {
        questionId: "connector-app",
        answerText: target.connectorLabel,
        selectedOptionIds: [target.connectorOptionId],
        selectedValues: [target.autoConnector],
      },
    });
  }, [autoConnectorSubmittedRef, chatApi, chatStatus, creating, messages, spec]);

  function handleSubmit(text: string) {
    if (creating) return;
    if (!loopId) {
      onCreateLoop(text);
      return;
    }
    chatApi?.sendMessage({ text });
  }

  function submitAskQuestionAnswer(answer: InteractivePromptAnswer) {
    if (!pendingQuestion || !chatApi) return;
    void chatApi.addToolOutput({
      tool: pendingQuestion.toolName,
      toolCallId: pendingQuestion.toolCallId,
      output: {
        questionId: pendingQuestion.input.questionId,
        answerText: answer.answerText,
        selectedOptionIds: answer.selectedOptionIds,
        selectedValues: answer.selectedValues,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
      },
    });
  }

  function dismissAskQuestion() {
    if (!pendingQuestion || !chatApi) return;
    void chatApi.addToolOutput({
      tool: pendingQuestion.toolName,
      toolCallId: pendingQuestion.toolCallId,
      output: {
        questionId: pendingQuestion.input.questionId,
        answerText: "skipped",
        selectedOptionIds: [],
        selectedValues: [],
        skipped: true,
      },
    });
  }

  function handlePromptSuggestionSelect(suggestion: ConductorPromptSuggestion) {
    if (creating || chatStatus === "streaming" || chatStatus === "submitted") return;

    if (pendingReplyOptions && chatApi) {
      void chatApi.addToolOutput({
        tool: "presentReplyOptions",
        toolCallId: pendingReplyOptions.toolCallId,
        output: {
          selectedOptionId: suggestion.id,
          message: suggestion.message,
        },
      });
      return;
    }

    if (!loopId) {
      onCreateLoop(suggestion.message);
      return;
    }
    chatApi?.sendMessage({ text: suggestion.message });
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
      pendingQuestion={pendingQuestion}
      pendingReplyOptionsCallId={pendingReplyOptions?.toolCallId ?? null}
      promptSuggestions={promptSuggestions}
      onAskQuestionAnswer={submitAskQuestionAnswer}
      onAskQuestionDismiss={dismissAskQuestion}
      onPromptSuggestionSelect={handlePromptSuggestionSelect}
      spec={spec}
      missingSlots={missingSlots}
      status={status}
      compiledPlanId={compiledPlanId}
      eventTrigger={eventTrigger}
      onRun={onRun}
      thinkingLabel={creating ? "Creating loop…" : "Thinking…"}
      forceThinking={creating}
      composerDisabled={creating}
    />
  );
}

function ConductorBuilderSession({ initialLoopId }: { initialLoopId?: string }) {
  const [loopId, setLoopId] = useState<string | null>(initialLoopId ?? null);
  const [loopName, setLoopName] = useState<string | undefined>();
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [missingSlots, setMissingSlots] = useState<string[]>([]);
  const [compiledPlanId, setCompiledPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [eventTrigger, setEventTrigger] = useState<LoopEventTriggerStatus | null>(null);
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingUserBubble, setPendingUserBubble] = useState<UIMessage | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrapPromptSentRef = useRef(false);
  const autoConnectorSubmittedRef = useRef<string | null>(null);
  const createdInSessionRef = useRef(false);

  const handleLoopMetaChange = useCallback((meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
    eventTrigger?: LoopEventTriggerStatus | null;
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

  async function createLoopFromPrompt(text: string) {
    setPendingUserBubble(makeUserMessage(text));
    setCreating(true);
    pendingPromptRef.current = text;
    bootstrapPromptSentRef.current = false;
    try {
      const res = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create loop");
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
      alert(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setCreating(false);
    }
  }

  async function handleRun() {
    if (!loopId) return;
    const res = await apiFetch(`/api/loops/${loopId}/runs`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) alert(data.error ?? "Run failed");
    else if (data.run?.id) {
      window.location.href = `/dashboard/loops/${loopId}/runs/${data.run.id}`;
    }
  }

  const liveProps = {
    loopId,
    loopName,
    spec,
    missingSlots,
    compiledPlanId,
    status,
    eventTrigger,
    input,
    setInput,
    creating,
    pendingUserBubble,
    setPendingUserBubble,
    pendingPromptRef,
    bootstrapPromptSentRef,
    autoConnectorSubmittedRef,
    createdInSessionRef,
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
      onLoopMetaChange={handleLoopMetaChange}
    >
      {live}
    </ConductorChatBridge>
  );
}

export function ConductorBuilder({ loopId: initialLoopId }: { loopId?: string }) {
  return <ConductorBuilderSession initialLoopId={initialLoopId} />;
}

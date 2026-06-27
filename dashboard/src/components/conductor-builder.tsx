"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { ConductorBuilderLayout } from "@/components/conductor/conductor-builder-layout";
import {
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
  onMessagesChange: (messages: UIMessage[]) => void;
  onStatusChange: (status: ChatStatus) => void;
  onLoopMetaChange: (meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
  }) => void;
  onChatReady: (api: {
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  }) => void;
};

function ConductorChatBridge({
  loopId,
  pendingPrompt,
  skipLoopFetch = false,
  bootstrapPromptSentRef,
  onMessagesChange,
  onStatusChange,
  onLoopMetaChange,
  onChatReady,
}: ConductorChatBridgeProps) {
  const onMessagesChangeRef = useRef(onMessagesChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onLoopMetaChangeRef = useRef(onLoopMetaChange);
  const onChatReadyRef = useRef(onChatReady);

  useEffect(() => { onMessagesChangeRef.current = onMessagesChange; }, [onMessagesChange]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onLoopMetaChangeRef.current = onLoopMetaChange; }, [onLoopMetaChange]);
  useEffect(() => { onChatReadyRef.current = onChatReady; }, [onChatReady]);

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

  const { messages, sendMessage, status: chatStatus, addToolOutput, setMessages } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const chatLoadedRef = useRef(false);

  useEffect(() => {
    onChatReadyRef.current({ sendMessage, addToolOutput });
  }, [addToolOutput, sendMessage]);

  useEffect(() => {
    onMessagesChangeRef.current(messages);
  }, [messages]);

  useEffect(() => {
    onStatusChangeRef.current(chatStatus);
  }, [chatStatus]);

  useEffect(() => {
    chatLoadedRef.current = false;

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
        if (part.type === "tool-patchLoopSpec" && part.state === "output-available") {
          const output = part.output as { spec?: Record<string, unknown>; missingSlots?: string[] };
          onLoopMetaChangeRef.current({
            spec: output.spec ?? null,
            missingSlots: output.missingSlots,
          });
        }
        if (part.type === "tool-compileLoop" && part.state === "output-available") {
          const output = part.output as { ok?: boolean; plan?: { id: string } };
          if (output.ok && output.plan?.id) {
            onLoopMetaChangeRef.current({ compiledPlanId: output.plan.id });
          }
        }
        if (part.type === "tool-activateLoop" && part.state === "output-available") {
          const output = part.output as { ok?: boolean; status?: string };
          if (output.ok) {
            onLoopMetaChangeRef.current({ status: output.status ?? "active" });
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

  return null;
}

function ConductorBuilderSession({ initialLoopId }: { initialLoopId?: string }) {
  const [loopId, setLoopId] = useState<string | null>(initialLoopId ?? null);
  const [loopName, setLoopName] = useState<string | undefined>();
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [missingSlots, setMissingSlots] = useState<string[]>([]);
  const [compiledPlanId, setCompiledPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingUserBubble, setPendingUserBubble] = useState<UIMessage | null>(null);
  const [chatMessages, setChatMessages] = useState<UIMessage[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("ready");
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrapPromptSentRef = useRef(false);
  const chatApiRef = useRef<{
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  } | null>(null);
  const createdInSessionRef = useRef(false);

  const displayMessages = useMemo(() => {
    if (chatMessages.length > 0) return chatMessages;
    if (pendingUserBubble) return [pendingUserBubble];
    return [];
  }, [chatMessages, pendingUserBubble]);

  useEffect(() => {
    if (chatMessages.some((message) => message.role === "user")) {
      setPendingUserBubble(null);
    }
  }, [chatMessages]);

  const pendingQuestion = useMemo(() => findPendingInteractivePrompt(displayMessages), [displayMessages]);
  const pendingReplyOptions = useMemo(
    () => findPendingPresentReplyOptions(displayMessages),
    [displayMessages],
  );

  const promptSuggestions = useMemo(
    () => deriveConductorPromptSuggestions({
      messages: displayMessages,
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
      displayMessages,
      missingSlots,
      pendingQuestion,
      pendingReplyOptions,
      status,
    ],
  );

  const handleLoopMetaChange = useCallback((meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
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
  }, []);

  const handleChatReady = useCallback((api: {
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  }) => {
    chatApiRef.current = api;
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

  function handleSubmit(text: string) {
    if (creating) return;
    if (!loopId) {
      void createLoopFromPrompt(text);
      return;
    }
    chatApiRef.current?.sendMessage({ text });
  }

  function submitAskQuestionAnswer(answer: InteractivePromptAnswer) {
    if (!pendingQuestion || !chatApiRef.current) return;
    void chatApiRef.current.addToolOutput({
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
    if (!pendingQuestion || !chatApiRef.current) return;
    void chatApiRef.current.addToolOutput({
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

    if (pendingReplyOptions && chatApiRef.current) {
      void chatApiRef.current.addToolOutput({
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
      void createLoopFromPrompt(suggestion.message);
      return;
    }
    chatApiRef.current?.sendMessage({ text: suggestion.message });
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

  const effectiveChatStatus: ChatStatus = creating
    ? "submitted"
    : loopId
      ? chatStatus
      : "ready";

  return (
    <>
      {loopId ? (
        <ConductorChatBridge
          loopId={loopId}
          pendingPrompt={pendingPromptRef.current}
          skipLoopFetch={createdInSessionRef.current}
          bootstrapPromptSentRef={bootstrapPromptSentRef}
          onMessagesChange={setChatMessages}
          onStatusChange={setChatStatus}
          onLoopMetaChange={handleLoopMetaChange}
          onChatReady={handleChatReady}
        />
      ) : null}
      <ConductorBuilderLayout
        loopId={loopId ?? undefined}
        loopName={loopName}
        messages={displayMessages}
        chatStatus={effectiveChatStatus}
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
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
        onRun={loopId ? () => void handleRun() : undefined}
        thinkingLabel={creating ? "Creating loop…" : "Thinking…"}
        forceThinking={creating}
        composerDisabled={creating}
      />
    </>
  );
}

export function ConductorBuilder({ loopId: initialLoopId }: { loopId?: string }) {
  return <ConductorBuilderSession initialLoopId={initialLoopId} />;
}

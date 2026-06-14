"use client";


import dynamic from "next/dynamic";
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
import { Paperclip, Plus } from "lucide-react";
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
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
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
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";

const LoopSuggestionCards = dynamic(
  () => import("@/components/loop-suggestion-cards").then((mod) => mod.LoopSuggestionCards),
  { ssr: false },
);


export default function NewLoopBuilderPage() {
  const sessionIdRef = useRef<string | null>(null);
  const [dismissedPromptId, setDismissedPromptId] = useState<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/loop-builder/chat",
    body: () => ({ sessionId: sessionIdRef.current ?? undefined }),
  }), []);

  const refreshSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/loop-builder/sessions/${sessionId}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to load builder session");
    sessionIdRef.current = sessionId;
    return payload.messages as UIMessage[];
  }, []);

  const { messages, sendMessage, setMessages, status, error, stop, addToolApprovalResponse, addToolOutput } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: currentMessages })
      || lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMessages }),
    onData: (part) => {
      if (part.type !== "data-session") return;
      const nextId = (part.data as { sessionId?: string }).sessionId;
      if (!nextId || nextId === sessionIdRef.current) return;
      sessionIdRef.current = nextId;
      window.history.replaceState(null, "", `/dashboard/loops/new?session=${encodeURIComponent(nextId)}`);
    },
    onFinish: () => {
      if (sessionIdRef.current) void refreshSession(sessionIdRef.current).then(setMessages);
    },
  });

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session");
    if (sessionId) void refreshSession(sessionId).then(setMessages);
  }, [refreshSession, setMessages]);

  const activeInteractivePrompt = findActiveInteractivePrompt(messages);
  const activePromptId = activeInteractivePrompt?.toolCallId ?? null;
  const showInteractivePrompt = activePromptId !== null && activePromptId !== dismissedPromptId;
  const submitComposerText = useCallback(async (text: string) => {
    const answerText = text.trim();
    if (!answerText) return;

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
        setMessages([
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
  }, [activeInteractivePrompt, activePromptId, dismissedPromptId, messages, sendMessage, setMessages]);

  useEffect(() => {
    setDismissedPromptId(null);
  }, [activePromptId]);

  return (
    <div className="relative flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden bg-white">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[400px] bg-gradient-to-t from-slate-100 to-transparent" />
      <div className="relative z-10 flex h-full flex-col overflow-hidden">
        <Conversation>
            <ConversationContent className="mx-auto max-w-3xl gap-8 p-4">
              <ScrollOnToolComplete messages={messages} />
              {messages.length === 0 && (
                <LoopSuggestionCards
                  className="max-w-3xl"
                  onSelect={submitComposerText}
                />
              )}
              {messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      if (part.type === "text") return <MessageResponse key={index}>{part.text}</MessageResponse>;
                      if (isReasoningUIPart(part)) {
                        return (
                          <Reasoning isStreaming={part.state === "streaming"} defaultOpen key={`reasoning-${index}`}>
                            <ReasoningTrigger />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        );
                      }
                      if (isToolUIPart(part)) {
                        const toolName = getToolName(part);
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
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })} className="border-[#92400e] bg-[#fffbeb] text-[#92400e] hover:bg-[#fef3c7]">Approve</ConfirmationAction>
                              </ConfirmationActions>
                            </Confirmation>
                          );
                        }
                        if (toolName === "getAvailableTools" && part.state === "output-available") {
                          return <AvailableTools key={index} part={part} />;
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
              {error && <p className="text-sm text-destructive">{error.message}</p>}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <motion.div
              className="relative overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-white shadow-sm transition-colors focus-within:border-[#d1d5db]"
              layout
              transition={{ layout: { duration: 0.32, ease: [0.16, 1, 0.3, 1] } }}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {showInteractivePrompt ? (
                  <motion.div
                    key="interactive-prompt"
                    animate={{ clipPath: "inset(0% 0% 0% 0% round 24px)", opacity: 1, y: 0 }}
                    exit={{ clipPath: "inset(85% 0% 0% 0% round 24px)", opacity: 0, y: 20 }}
                    initial={{ clipPath: "inset(85% 0% 0% 0% round 24px)", opacity: 0, y: 20 }}
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
                ) : (
                  <motion.div
                    key="prompt-input"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                  <PromptInput className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0" onSubmit={({ text }) => submitComposerText(text)}>
                    <PromptInputTextarea placeholder="Describe the loop, answer a clarification, or request a refinement..." className="min-h-0 pr-12 pb-2" />

                    <div className="absolute bottom-3 left-4 flex items-center gap-4 text-slate-400">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="flex size-7 items-center justify-center rounded-full bg-slate-100 transition-colors hover:bg-slate-200">
                            <Plus size={16} className="text-slate-600" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 rounded-2xl p-2 shadow-lg">
                          <DropdownMenuItem className="gap-3 rounded-xl px-3 py-2 text-[14px]">
                            <Paperclip size={18} className="text-slate-700" />
                            <span>Add photos & files</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                      <PromptInputSubmit onStop={stop} status={status} className="rounded-full bg-indigo-900 text-white hover:bg-indigo-800" />
                    </PromptInputFooter>
                  </PromptInput>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </div>
        <p className="pb-4 text-center text-[11px] text-[#999]">Tallei can make mistakes. Check important info.</p>
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
          ? "rounded-none border-0 shadow-none"
          : "my-3 rounded-2xl border border-[#e8e5f0] shadow-sm",
      )}>
        <div className="flex items-center gap-2 px-4 pb-2 pt-4 text-sm font-medium">
          <span>{input.question ?? "Analyzing your request"}</span>
          <span className="inline-flex gap-0.5">
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: "0ms" }} />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: "150ms" }} />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: "300ms" }} />
          </span>
        </div>
        {options.length > 0 && (
          <div className="space-y-1 px-2 pb-3">
            {options.map((option, optionIndex) => (
              <div
                key={option.id ?? `option-${optionIndex}`}
                className="flex animate-in fade-in slide-in-from-bottom-1 items-start gap-3 rounded-lg px-2.5 py-2"
                style={{ animationDuration: "300ms" }}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#e8e5f0] bg-white overflow-hidden">
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
            <div className="flex animate-pulse items-start gap-3 rounded-lg px-2.5 py-2">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#e8e5f0] bg-white text-[11px] text-[#8a86a0]/30">
                <span className="h-4 w-4 rounded-full bg-[#e8e5f0]" />
              </span>
              <span className="h-4 w-32 rounded bg-[#e8e5f0]" />
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

function findActiveInteractivePrompt(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "interactivePrompt"
        && (part.state === "input-streaming" || part.state === "input-available")) {
        return part;
      }
    }
  }
  return null;
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
        <div className="space-y-2 p-3">
          {(output.tools ?? []).length === 0 && <p className="text-sm text-muted-foreground">No external connector actions are required.</p>}
          {(output.tools ?? []).map((item, index) => (
            <div className="rounded-md border p-3 text-sm" key={`${item.name}-${index}`}>
              <div className="font-medium">{item.name ?? "Available tool"}</div>
              <div className="text-muted-foreground">{item.description}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                {item.connected ? "Connected" : "Connection required"} · Risk: {item.risk ?? "unknown"}
              </div>
            </div>
          ))}
        </div>
      </ToolContent>
    </CollapsibleTool>
  );
}

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
import { ArrowLeft, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type BuilderSession = {
  id: string;
  phase: string;
  composioSessionId: string;
  intentAnalysis: unknown;
  discoveredToolContracts: Array<{ name?: string; toolRef?: string }>;
  currentProposal: { title?: string; summary?: string } | null;
  specId: string | null;
  workflowId: string | null;
  error: { message: string } | null;
};

export default function NewLoopBuilderPage() {
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<BuilderSession | null>(null);
  const [progress, setProgress] = useState<Array<{ id: number; message: string; status: string }>>([]);
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
    setSession(payload.session);
    return payload.messages as UIMessage[];
  }, []);

  const { messages, sendMessage, setMessages, status, error, stop, addToolApprovalResponse, addToolOutput } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: currentMessages })
      || lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMessages }),
    onData: (part) => {
      if (part.type === "data-progress") {
        const events = (part.data as { events?: Array<{ id: number; message: string; status: string }> }).events;
        if (events) setProgress(events);
        return;
      }
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

  useEffect(() => {
    setDismissedPromptId(null);
  }, [activePromptId]);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-[1500px] flex-col gap-5 p-6">
      <header className="flex items-start justify-between gap-4 border-b pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><Wand2 className="size-4" /> LOOP BUILDER</div>
          <h1 className="text-3xl font-semibold">Create a loop</h1>
          <p className="mt-1 text-muted-foreground">One durable session analyzes intent, discovers exact tools, drafts the spec, and builds the workflow.</p>
        </div>
        <Button asChild variant="outline"><Link href="/dashboard/loops"><ArrowLeft className="mr-2 size-4" />Back</Link></Button>
      </header>

      <main className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="flex min-h-[70vh] flex-col overflow-hidden">
          <Conversation>
            <ConversationContent>
              {messages.length === 0 && (
                <ConversationEmptyState
                  icon={<Wand2 className="size-8" />}
                  title="Describe the loop you want"
                  description="Intent analysis runs first and discovers the tools required for that intent."
                />
              )}
              {messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      if (part.type === "text") return <MessageResponse key={index}>{part.text}</MessageResponse>;
                      if (isReasoningUIPart(part)) {
                        return (
                          <Reasoning isStreaming={part.state === "streaming"} key={index}>
                            <ReasoningTrigger />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        );
                      }
                      if (isToolUIPart(part)) {
                        const toolName = getToolName(part);
                        if (toolName === "interactivePrompt") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
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
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: false })} variant="outline">Reject</ConfirmationAction>
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })}>Approve</ConfirmationAction>
                              </ConfirmationActions>
                            </Confirmation>
                          );
                        }
                        if (toolName === "getAvailableTools" && part.state === "output-available") {
                          return <AvailableTools key={index} part={part} />;
                        }
                        return (
                          <Tool defaultOpen key={index}>
                            {part.type === "dynamic-tool"
                              ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
                              : <ToolHeader type={part.type} state={part.state} />}
                            <ToolContent>
                              <ToolInput input={part.input} />
                              <ToolOutput output={part.output} errorText={part.errorText} />
                            </ToolContent>
                          </Tool>
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
          <div className="relative border-t p-4">
            <div className="relative overflow-hidden rounded-lg">
              <AnimatePresence initial={false} mode="wait">
                {showInteractivePrompt ? (
                  <motion.div
                    key="interactive-prompt"
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    initial={{ opacity: 0, scale: 0.98, y: 16 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
                    exit={{ opacity: 0, scale: 0.98, y: 12 }}
                    initial={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <PromptInput onSubmit={({ text }) => {
                      if (text.trim()) return sendMessage({ text });
                    }}>
                      <PromptInputTextarea placeholder="Describe the loop, answer a clarification, or request a refinement..." />
                      <PromptInputFooter>
                        <span className="text-xs text-muted-foreground">{session ? `Phase: ${session.phase}` : "A new session starts with your first message"}</span>
                        <PromptInputSubmit onStop={stop} status={status} />
                      </PromptInputFooter>
                    </PromptInput>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </Card>

        <Card className="h-fit space-y-5 p-5">
          <div>
            <h2 className="font-semibold">Current artifacts</h2>
            <p className="text-sm text-muted-foreground">The persisted projection for this builder session.</p>
          </div>
          <Artifact label="Session" value={session?.id} />
          <Artifact label="Composio session" value={session?.composioSessionId} />
          <Artifact label="Phase" value={session?.phase} />
          <Artifact label="Intent analysis" value={session?.intentAnalysis ? "Resolved or awaiting clarification" : undefined} />
          <Artifact label="Discovered tools" value={session ? `${session.discoveredToolContracts.length} exact contracts` : undefined} />
          <Artifact label="Spec" value={session?.specId ?? undefined} />
          <Artifact label="Workflow graph" value={session?.currentProposal?.title} />
          <Artifact label="Saved workflow" value={session?.workflowId ?? undefined} />
          {progress.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Progress</div>
              <div className="space-y-2">
                {progress.slice(-5).map((event) => (
                  <div className="text-sm" key={event.id}>{event.message}</div>
                ))}
              </div>
            </div>
          )}
          {session?.error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{session.error.message}</p>}
        </Card>
      </main>
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
    return <p className="my-3 text-sm text-muted-foreground">Preparing choices...</p>;
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
    <Tool defaultOpen>
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
    </Tool>
  );
}

function Artifact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="border-b pb-3 last:border-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all text-sm">{value || "Not created yet"}</div>
    </div>
  );
}

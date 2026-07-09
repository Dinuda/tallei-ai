"use client";

import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";
import { memo, useMemo, type ReactNode } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import {
  collectSupersededAskQuestionCallIds,
  isToolPart,
  messagePartsRevision,
  messagesUiStateRevision,
  type ChatStatus,
} from "@/components/conductor/conductor-shared";
import { ConductorReasoningPart } from "@/components/conductor/conductor-reasoning-part";
import { ConductorToolPart } from "@/components/conductor/conductor-tool-part";
import { ConductorTranscriptErrorBanner } from "@/components/conductor/conductor-transcript-error-banner";
import { TranscriptPartEnter } from "@/components/conductor/transcript-part-enter";
import { buildTranscriptSegments } from "@/components/conductor/transcript-stream-order";
import type { ConductorTranscriptError } from "@/lib/conductor-transcript-error";
import { cn } from "@/lib/utils";

type TranscriptPartOptions = {
  chatStatus: ChatStatus;
  lastMessageId: string | undefined;
  isStreamingPart: boolean;
  messages: UIMessage[];
  messagesRevision: string;
  pendingInteractivePromptCallIds: Set<string>;
  pendingReplyOptionsCallId: string | null;
  supersededAskQuestionCallIds: Set<string>;
  spec: Record<string, unknown> | null;
  pauseReasoningForUserInput: boolean;
};

function renderTranscriptPart(
  part: NonNullable<UIMessage["parts"]>[number],
  key: string,
  options: TranscriptPartOptions & { expandReasoningByDefault?: boolean },
) {
  let content: ReactNode = null;

  if (part.type === "reasoning") {
    content = (
      <ConductorReasoningPart
        expandByDefault={options.expandReasoningByDefault ?? false}
        pauseForUserInput={options.pauseReasoningForUserInput}
        part={part as ReasoningUIPart}
      />
    );
  } else if (part.type === "text") {
    content = (
      <div data-transcript-text>
        <MessageResponse isAnimating={options.isStreamingPart}>
          {part.text}
        </MessageResponse>
      </div>
    );
  } else if (isToolPart(part.type)) {
    content = (
      <ConductorToolPart
        messages={options.messages}
        messagesRevision={options.messagesRevision}
        part={part as DynamicToolUIPart}
        pendingInteractivePromptCallIds={options.pendingInteractivePromptCallIds}
        pendingReplyOptionsCallId={options.pendingReplyOptionsCallId}
        supersededAskQuestionCallIds={options.supersededAskQuestionCallIds}
        spec={options.spec}
      />
    );
  }

  if (!content) return null;

  return (
    <TranscriptPartEnter key={key}>
      {content}
    </TranscriptPartEnter>
  );
}

type AssistantTranscriptTurnProps = {
  message: UIMessage;
  messages: UIMessage[];
  messagesRevision: string;
  chatStatus: ChatStatus;
  lastMessageId: string | undefined;
  pendingInteractivePromptCallIds: Set<string>;
  pendingReplyOptionsCallId: string | null;
  supersededAskQuestionCallIds: Set<string>;
  spec: Record<string, unknown> | null;
  pauseReasoningForUserInput: boolean;
};

function AssistantTranscriptTurnInner({
  message,
  messages,
  messagesRevision,
  chatStatus,
  lastMessageId,
  pendingInteractivePromptCallIds,
  pendingReplyOptionsCallId,
  supersededAskQuestionCallIds,
  spec,
  pauseReasoningForUserInput,
}: AssistantTranscriptTurnProps) {
  const segments = buildTranscriptSegments(message.parts ?? []);
  const lastSegment = segments.at(-1);
  const lastPart = lastSegment?.type === "patch-beat"
    ? lastSegment.parts.at(-1)
    : lastSegment?.type === "part"
      ? lastSegment.part
      : undefined;
  const latestStreamingReasoningPart = (() => {
    if (pauseReasoningForUserInput) return null;
    if (chatStatus !== "streaming" || message.id !== lastMessageId) return null;
    for (let index = (message.parts ?? []).length - 1; index >= 0; index -= 1) {
      const part = message.parts?.[index];
      if (part?.type === "reasoning" && (part as ReasoningUIPart).state === "streaming") {
        return part;
      }
    }
    return null;
  })();

  const renderOptions: TranscriptPartOptions = {
    chatStatus,
    lastMessageId,
    isStreamingPart: false,
    messages,
    messagesRevision,
    pendingInteractivePromptCallIds,
    pendingReplyOptionsCallId,
    supersededAskQuestionCallIds,
    spec,
    pauseReasoningForUserInput,
  };

  return (
    <div className="conductor-transcript-stream w-full max-w-full min-w-0">
      {segments.map((segment, segmentIndex) => {
        if (segment.type === "patch-beat") {
          return (
            <div key={`patch-beat-${segmentIndex}`} className="conductor-transcript-cluster">
              {segment.parts.map((part, partIndex) =>
                renderTranscriptPart(
                  part,
                  `patch-beat-${segmentIndex}-${partIndex}`,
                  {
                    ...renderOptions,
                    expandReasoningByDefault: part === latestStreamingReasoningPart,
                    isStreamingPart:
                      chatStatus === "streaming"
                      && message.id === lastMessageId
                      && part === lastPart,
                  },
                ),
              )}
            </div>
          );
        }

        return renderTranscriptPart(
          segment.part,
          `part-${segmentIndex}`,
          {
            ...renderOptions,
            expandReasoningByDefault: segment.part === latestStreamingReasoningPart,
            isStreamingPart:
              chatStatus === "streaming"
              && message.id === lastMessageId
              && segment.part === lastPart,
          },
        );
      })}
    </div>
  );
}

function assistantTranscriptTurnPropsAreEqual(
  prev: AssistantTranscriptTurnProps,
  next: AssistantTranscriptTurnProps,
): boolean {
  const isLiveTurn = next.message.id === next.lastMessageId && next.chatStatus === "streaming";
  if (isLiveTurn) return false;

  if (prev.message.id !== next.message.id) return false;
  if (messagePartsRevision(prev.message) !== messagePartsRevision(next.message)) return false;
  if (prev.messagesRevision !== next.messagesRevision) return false;
  if (prev.spec !== next.spec) return false;
  if (prev.pendingInteractivePromptCallIds !== next.pendingInteractivePromptCallIds) return false;
  if (prev.pauseReasoningForUserInput !== next.pauseReasoningForUserInput) return false;
  if (prev.pendingReplyOptionsCallId !== next.pendingReplyOptionsCallId) return false;
  if (prev.supersededAskQuestionCallIds !== next.supersededAskQuestionCallIds) return false;
  return true;
}

const AssistantTranscriptTurn = memo(
  AssistantTranscriptTurnInner,
  assistantTranscriptTurnPropsAreEqual,
);

export function ConductorBuilderChat({
  messages,
  chatStatus,
  pendingInteractivePromptCallIds,
  pendingReplyOptionsCallId,
  spec,
  showThinking,
  thinkingLabel = "Thinking…",
  pauseReasoningForUserInput = false,
  transcriptError = null,
  onRetry,
  className,
  emptyState,
}: {
  messages: UIMessage[];
  chatStatus: ChatStatus;
  pendingInteractivePromptCallIds: Set<string>;
  pendingReplyOptionsCallId: string | null;
  spec: Record<string, unknown> | null;
  showThinking: boolean;
  thinkingLabel?: string;
  pauseReasoningForUserInput?: boolean;
  transcriptError?: ConductorTranscriptError | null;
  onRetry?: () => void;
  className?: string;
  emptyState?: React.ReactNode;
}) {
  const lastMessageId = messages.at(-1)?.id;
  const messagesRevision = useMemo(
    () => messagesUiStateRevision(messages),
    [messages],
  );
  const supersededAskQuestionCallIds = useMemo(
    () => collectSupersededAskQuestionCallIds(messages),
    [messages],
  );

  return (
    <Conversation className={cn("conductor-builder-chat flex-1 min-h-0", className)}>
      <ConversationContent className="mx-auto max-w-3xl gap-6 p-4">
        {messages.length === 0 && emptyState ? emptyState : null}

        {messages.map((message) => (
          <Message key={message.id} from={message.role}>
            <MessageContent className={message.role === "assistant" ? "w-full" : undefined}>
              {message.role === "user" ? (
                message.parts?.map((part, i) =>
                  part.type === "text" ? <span key={i}>{part.text}</span> : null,
                )
              ) : (
                <AssistantTranscriptTurn
                  chatStatus={chatStatus}
                  lastMessageId={lastMessageId}
                  message={message}
                  messages={messages}
                  messagesRevision={messagesRevision}
                  pauseReasoningForUserInput={pauseReasoningForUserInput}
                  pendingInteractivePromptCallIds={pendingInteractivePromptCallIds}
                  pendingReplyOptionsCallId={pendingReplyOptionsCallId}
                  supersededAskQuestionCallIds={supersededAskQuestionCallIds}
                  spec={spec}
                />
              )}
            </MessageContent>
          </Message>
        ))}

        {transcriptError ? (
          <ConductorTranscriptErrorBanner error={transcriptError} onRetry={onRetry} />
        ) : null}

        {showThinking ? (
          <Message from="assistant">
            <MessageContent>
              <TranscriptPartEnter>
                <TranscriptThinkingIndicator label={thinkingLabel} variant="shimmer" />
              </TranscriptPartEnter>
            </MessageContent>
          </Message>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

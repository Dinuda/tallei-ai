"use client";

import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import { isToolPart } from "@/components/conductor/conductor-shared";
import type { ChatStatus } from "@/components/conductor/conductor-shared";
import {
  ConductorReasoningPart,
  ConductorToolPart,
} from "@/components/conductor/conductor-tool-part";
import { buildTranscriptSegments } from "@/components/conductor/transcript-stream-order";
import { cn } from "@/lib/utils";

function renderTranscriptPart(
  part: NonNullable<UIMessage["parts"]>[number],
  key: string,
  options: {
    chatStatus: ChatStatus;
    messageId: string;
    lastMessageId: string | undefined;
    isStreamingPart: boolean;
    messages: UIMessage[];
    pendingInteractivePromptCallIds: Set<string>;
    pendingReplyOptionsCallId: string | null;
    spec: Record<string, unknown> | null;
  },
) {
  if (part.type === "reasoning") {
    return (
      <ConductorReasoningPart
        key={key}
        part={part as ReasoningUIPart}
      />
    );
  }
  if (part.type === "text") {
    return (
      <div key={key} data-transcript-text>
        <MessageResponse isAnimating={options.isStreamingPart}>
          {part.text}
        </MessageResponse>
      </div>
    );
  }
  if (isToolPart(part.type)) {
    return (
      <ConductorToolPart
        key={key}
        messages={options.messages}
        part={part as DynamicToolUIPart}
        pendingInteractivePromptCallIds={options.pendingInteractivePromptCallIds}
        pendingReplyOptionsCallId={options.pendingReplyOptionsCallId}
        spec={options.spec}
      />
    );
  }
  return null;
}

function AssistantTranscriptTurn({
  message,
  messages,
  chatStatus,
  lastMessageId,
  pendingInteractivePromptCallIds,
  pendingReplyOptionsCallId,
  spec,
}: {
  message: UIMessage;
  messages: UIMessage[];
  chatStatus: ChatStatus;
  lastMessageId: string | undefined;
  pendingInteractivePromptCallIds: Set<string>;
  pendingReplyOptionsCallId: string | null;
  spec: Record<string, unknown> | null;
}) {
  const segments = buildTranscriptSegments(message.parts ?? []);
  const lastSegment = segments.at(-1);
  const lastPart = lastSegment?.type === "patch-beat"
    ? lastSegment.parts.at(-1)
    : lastSegment?.type === "part"
      ? lastSegment.part
      : undefined;

  const renderOptions = {
    chatStatus,
    messageId: message.id,
    lastMessageId,
    isStreamingPart: false,
    messages,
    pendingInteractivePromptCallIds,
    pendingReplyOptionsCallId,
    spec,
  };

  return (
    <div className="conductor-transcript-stream max-w-full min-w-0">
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

export function ConductorBuilderChat({
  messages,
  chatStatus,
  pendingInteractivePromptCallIds,
  pendingReplyOptionsCallId,
  spec,
  showThinking,
  thinkingLabel = "Thinking…",
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
  className?: string;
  emptyState?: React.ReactNode;
}) {
  const lastMessageId = messages.at(-1)?.id;

  return (
    <Conversation className={cn("conductor-builder-chat flex-1 min-h-0", className)}>
      <ConversationContent className="mx-auto max-w-3xl gap-6 p-4">
        {messages.length === 0 && emptyState ? emptyState : null}

        {messages.map((message) => (
          <Message key={message.id} from={message.role}>
            <MessageContent>
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
                  pendingInteractivePromptCallIds={pendingInteractivePromptCallIds}
                  pendingReplyOptionsCallId={pendingReplyOptionsCallId}
                  spec={spec}
                />
              )}
            </MessageContent>
          </Message>
        ))}

        {showThinking ? (
          <Message from="assistant">
            <MessageContent>
              <TranscriptThinkingIndicator label={thinkingLabel} variant="shimmer" />
            </MessageContent>
          </Message>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

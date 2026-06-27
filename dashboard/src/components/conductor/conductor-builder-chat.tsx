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
import { cn } from "@/lib/utils";

export function ConductorBuilderChat({
  messages,
  chatStatus,
  pendingQuestionCallId,
  pendingReplyOptionsCallId,
  showThinking,
  thinkingLabel = "Thinking…",
  className,
}: {
  messages: UIMessage[];
  chatStatus: ChatStatus;
  pendingQuestionCallId: string | null;
  pendingReplyOptionsCallId: string | null;
  showThinking: boolean;
  thinkingLabel?: string;
  className?: string;
}) {
  const lastMessageId = messages.at(-1)?.id;

  return (
    <Conversation
      className={cn(
        "min-h-[420px] min-w-0 border border-[var(--ed-border-light)] bg-white",
        className,
      )}
    >
      <ConversationContent>
        {messages.map((message) => (
          <Message key={message.id} from={message.role}>
            {message.role === "user" ? (
              <MessageContent>
                {message.parts?.map((part, i) =>
                  part.type === "text" ? <span key={i}>{part.text}</span> : null,
                )}
              </MessageContent>
            ) : (
              <div className="max-w-full min-w-0 space-y-2">
                {message.parts?.map((part, i) => {
                  if (part.type === "reasoning") {
                    return (
                      <ConductorReasoningPart
                        key={i}
                        part={part as ReasoningUIPart}
                        isMessageStreaming={chatStatus === "streaming" && message.id === lastMessageId}
                      />
                    );
                  }
                  if (part.type === "text") {
                    const isStreaming =
                      chatStatus === "streaming"
                      && message.id === lastMessageId
                      && i === (message.parts?.length ?? 0) - 1;
                    return (
                      <MessageResponse key={i} isAnimating={isStreaming}>
                        {part.text}
                      </MessageResponse>
                    );
                  }
                  if (isToolPart(part.type)) {
                    return (
                      <ConductorToolPart
                        key={i}
                        part={part as DynamicToolUIPart}
                        pendingQuestionCallId={pendingQuestionCallId}
                        pendingReplyOptionsCallId={pendingReplyOptionsCallId}
                      />
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </Message>
        ))}
        {showThinking ? (
          <div className="pl-1">
            <TranscriptThinkingIndicator label={thinkingLabel} variant="shimmer" />
          </div>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

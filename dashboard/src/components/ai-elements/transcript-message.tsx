"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  getToolName,
  isReasoningUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { Bot, BrainIcon, CheckCircle2, Circle, PauseCircle, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { type AgentPersonaUi } from "@/components/agent-persona/agent-persona";
import { builderFallbackNarration, prepareBuilderTranscriptParts } from "@/lib/loop-builder-transcript";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";

export type DataAgentPartData = {
  agentId?: string;
  agentName?: string;
  stepIndex?: number;
  totalAgents?: number;
  task?: string;
  persona?: AgentPersonaUi;
  phase?: "working" | "finished" | "queued" | "failed";
};

export type ShouldRenderTextContext = {
  text: string;
  partIndex: number;
  parts: UIMessage["parts"];
  messageRole?: UIMessage["role"];
  isStreaming?: boolean;
};

export type RenderMessagePartContext = {
  index: number;
  messageRole?: UIMessage["role"];
  parts: UIMessage["parts"];
  isStreaming?: boolean;
  expandReasoning?: boolean;
  transcriptVariant?: "builder" | "run";
  renderTool?: (part: ToolPart, toolName: string, index: number) => ReactNode | null | undefined;
  shouldRenderText?: (ctx: ShouldRenderTextContext) => boolean;
  hideFinalizeAgent?: boolean;
};

/** Merge consecutive text parts so streaming deltas render as one block. */
export function coalesceAdjacentTextParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const result: UIMessage["parts"] = [];
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) return;
    result.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  for (const part of parts) {
    if (part.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }
    flushText();
    result.push(part);
  }
  flushText();
  return result;
}

export function isDataAgentPart(
  part: UIMessage["parts"][number],
): part is { type: "data-agent"; data: DataAgentPartData } {
  return part.type === "data-agent"
    && "data" in part
    && part.data !== null
    && typeof part.data === "object"
    && !Array.isArray(part.data);
}

export function CollapsibleTool({ part, children }: { part: ToolPart; children: ReactNode }) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const isCompleted = part.state === "output-available";
  const open = isCompleted ? (userOpen ?? false) : (userOpen ?? true);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen === open) return;
    setUserOpen(nextOpen);
  };

  return (
    <Tool open={open} onOpenChange={handleOpenChange}>
      {children}
    </Tool>
  );
}

/** Stateless reasoning row for builder transcript — avoids Radix Collapsible update loops. */
function ExpandedReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const trimmed = text.trim();
  if (!trimmed && !isStreaming) return null;

  return (
    <div className="not-prose mb-4">
      <div className="flex w-full items-center gap-2 text-sm text-muted-foreground">
        <BrainIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 text-left">
          {isStreaming ? (
            <Shimmer duration={1}>Thinking...</Shimmer>
          ) : (
            "Thought for a few seconds"
          )}
        </span>
      </div>
      {trimmed ? (
        <div className="mt-4 text-sm text-muted-foreground">
          <MessageResponse isAnimating={isStreaming}>{text}</MessageResponse>
        </div>
      ) : null}
    </div>
  );
}

export function AgentTurnHeader({ data }: { data: DataAgentPartData }) {
  const persona = data.persona;
  const displayName = persona?.displayName ?? data.agentName ?? "Agent";
  const phase = data.phase ?? "working";
  const statusText = phase === "working"
    ? null
    : phase === "finished"
    ? "Done"
    : phase === "failed"
      ? "Failed"
      : phase === "queued"
        ? "Queued"
        : null;
  const StatusIcon = statusText === "Done"
    ? CheckCircle2
    : statusText === "Failed"
        ? XCircle
        : statusText === "Queued"
          ? Circle
          : PauseCircle;

  return (
    <div className="mb-4 flex items-center gap-4 border border-[#e5e7eb] bg-white px-4 py-3.5">
      <div className="grid size-12 shrink-0 place-items-center border border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]">
        <Bot className="size-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-[#111827]">{displayName}</p>
        {typeof data.stepIndex === "number" ? (
          <p className="mt-0.5 text-[13px] font-medium text-[#6b7280]">
            Agent {data.stepIndex + 1}
          </p>
        ) : null}
      </div>
      {statusText ? (
        <span className="inline-flex shrink-0 items-center gap-2 text-[13px] font-medium text-[#6b7280]">
          <StatusIcon className="size-4" strokeWidth={2} />
          {statusText}
        </span>
      ) : null}
    </div>
  );
}

function defaultShouldRenderText(ctx: ShouldRenderTextContext): boolean {
  return Boolean(ctx.text.trim());
}

export function renderGenericToolPart(part: ToolPart, index: number): ReactNode {
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

export function renderMessagePart(
  part: UIMessage["parts"][number],
  ctx: RenderMessagePartContext,
): ReactNode | null {
  const key = `part-${ctx.index}`;

  if (part.type === "text") {
    const text = part.text ?? "";
    const shouldRender = (ctx.shouldRenderText ?? defaultShouldRenderText)({
      text,
      partIndex: ctx.index,
      parts: ctx.parts,
      messageRole: ctx.messageRole,
      isStreaming: ctx.isStreaming,
    });
    if (!shouldRender) return null;
    return (
      <MessageResponse isAnimating={ctx.isStreaming} key={key}>
        {text}
      </MessageResponse>
    );
  }

  if (isDataAgentPart(part)) {
    return <AgentTurnHeader data={part.data} key={key} />;
  }

  if (isReasoningUIPart(part)) {
    const reasoningText = part.text ?? "";
    const reasoningStreaming = part.state === "streaming" && Boolean(ctx.isStreaming);
    if (ctx.transcriptVariant === "run") return null;
    if (!reasoningText.trim() && !reasoningStreaming) return null;
    if (ctx.expandReasoning) {
      return (
        <ExpandedReasoningBlock
          isStreaming={reasoningStreaming}
          key={key}
          text={reasoningText}
        />
      );
    }
    return (
      <Reasoning
        autoClose
        isStreaming={reasoningStreaming}
        key={key}
      >
        <ReasoningTrigger />
        <ReasoningContent isAnimating={reasoningStreaming}>
          {reasoningText}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (isToolUIPart(part)) {
    const toolName = getToolName(part);
    if (ctx.hideFinalizeAgent && toolName === "finalizeAgent" && part.state === "output-available") {
      return null;
    }
    const custom = ctx.renderTool?.(part, toolName, ctx.index);
    if (custom !== undefined) return custom;
    return renderGenericToolPart(part, ctx.index);
  }

  return null;
}

export function TranscriptMessageContent({
  message,
  renderTool,
  shouldRenderText,
  hideFinalizeAgent,
  isStreaming,
  expandReasoning = false,
  transcriptVariant = "builder",
}: {
  message: UIMessage;
  renderTool?: RenderMessagePartContext["renderTool"];
  shouldRenderText?: RenderMessagePartContext["shouldRenderText"];
  hideFinalizeAgent?: boolean;
  isStreaming?: boolean;
  expandReasoning?: boolean;
  transcriptVariant?: "builder" | "run";
}) {
  const parts = useMemo(
    () => message.role === "assistant" && transcriptVariant === "builder"
      ? prepareBuilderTranscriptParts(message.parts)
      : coalesceAdjacentTextParts(message.parts),
    [message.parts, message.role, transcriptVariant],
  );
  const fallbackNarration = useMemo(() => (
    message.role === "assistant" && transcriptVariant === "builder"
      ? builderFallbackNarration(message.parts, { isStreaming })
      : null
  ), [isStreaming, message.parts, message.role, transcriptVariant]);

  return (
    <>
      {parts.map((part, index) => renderMessagePart(part, {
        index,
        messageRole: message.role,
        parts,
        isStreaming,
        expandReasoning,
        transcriptVariant,
        renderTool,
        shouldRenderText,
        hideFinalizeAgent,
      }))}
      {fallbackNarration ? <MessageResponse>{fallbackNarration}</MessageResponse> : null}
    </>
  );
}

export function findActiveToolPart(
  messages: UIMessage[],
  toolNames: string[],
): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (
        part
        && isToolUIPart(part)
        && toolNames.includes(getToolName(part))
        && (part.state === "input-streaming" || part.state === "input-available")
      ) {
        return part;
      }
    }
  }
  return null;
}

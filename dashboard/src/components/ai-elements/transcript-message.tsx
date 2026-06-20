"use client";

import { useState, type ReactNode } from "react";
import {
  getToolName,
  isReasoningUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";

import { cn } from "@/lib/utils";
import { AgentPersonaAvatar } from "@/components/agent-persona/agent-persona-avatar";
import { agentStatusLine, roleBadgeClass, type AgentPersonaUi } from "@/components/agent-persona/agent-persona";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
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

export type RenderMessagePartContext = {
  index: number;
  messageRole?: UIMessage["role"];
  renderTool?: (part: ToolPart, toolName: string, index: number) => ReactNode | null | undefined;
  shouldRenderText?: (text: string) => boolean;
  hideFinalizeAgent?: boolean;
};

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

  return (
    <Tool open={open} onOpenChange={setUserOpen}>
      {children}
    </Tool>
  );
}

export function AgentTurnHeader({ data }: { data: DataAgentPartData }) {
  const persona = data.persona;
  const displayName = persona?.displayName ?? data.agentName ?? "Agent";
  const phase = data.phase ?? "working";
  const statusText = agentStatusLine(displayName, phase, data.task);

  return (
    <div className="mb-2 flex items-start gap-3 rounded-md border border-[#e4f5c6] bg-[#f8fdf2] px-3 py-2.5">
      {persona ? (
        <AgentPersonaAvatar persona={persona} size="md" />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-full border border-[#d1d5db] bg-white text-[11px] font-semibold text-[#374151]">
          {(displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2) || "A").toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[#182506]">{displayName}</span>
          {persona?.roleLabel ? (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                roleBadgeClass(persona.roleKey),
              )}
            >
              {persona.roleLabel}
            </span>
          ) : null}
          {typeof data.stepIndex === "number" && typeof data.totalAgents === "number" ? (
            <span className="text-[11px] text-[#7a9a4a]">
              Agent {data.stepIndex + 1} of {data.totalAgents}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs font-medium text-[#7eb71b]">{statusText}</p>
      </div>
    </div>
  );
}

function defaultShouldRenderText(text: string): boolean {
  return Boolean(text.trim());
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
    const shouldRender = (ctx.shouldRenderText ?? defaultShouldRenderText)(text);
    if (!shouldRender) return null;
    return <MessageResponse key={key}>{text}</MessageResponse>;
  }

  if (isDataAgentPart(part)) {
    return <AgentTurnHeader data={part.data} key={key} />;
  }

  if (isReasoningUIPart(part)) {
    const reasoningText = part.text?.trim() ?? "";
    if (!reasoningText && part.state !== "streaming") return null;
    return (
      <Reasoning
        defaultOpen={part.state === "streaming"}
        isStreaming={part.state === "streaming"}
        key={key}
      >
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
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
}: {
  message: UIMessage;
  renderTool?: RenderMessagePartContext["renderTool"];
  shouldRenderText?: RenderMessagePartContext["shouldRenderText"];
  hideFinalizeAgent?: boolean;
}) {
  return (
    <>
      {message.parts.map((part, index) => renderMessagePart(part, {
        index,
        messageRole: message.role,
        renderTool,
        shouldRenderText,
        hideFinalizeAgent,
      }))}
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

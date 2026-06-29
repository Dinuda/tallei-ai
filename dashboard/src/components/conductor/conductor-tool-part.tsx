"use client";

import type { DynamicToolUIPart, ReasoningUIPart } from "ai";
import { BadgeQuestionMark } from "lucide-react";
import { useState } from "react";

import { CollapsibleContent } from "@/components/ui/collapsible";
import { Reasoning, ReasoningTrigger, reasoningStreamdownPlugins } from "@/components/ai-elements/reasoning";
import { ConductorReasoningStream, CONDUCTOR_REASONING_COLLAPSE_MS } from "@/components/conductor/conductor-reasoning-stream";
import { Streamdown } from "streamdown";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { BuilderCompletedCard } from "@/components/conductor/builder-completed-card";
import { BuilderConnectToolkitCard } from "@/components/conductor/builder-connect-toolkit-card";
import {
  formatActivateSummary,
  formatCompileSummary,
  formatConnectorSummary,
  formatDiscoverConnectorsSummary,
  formatPatchSummary,
  formatTestRunSummary,
  formatToolInputPreview,
} from "@/components/conductor/conductor-tool-formatters";
import type {
  AskQuestionInput,
  AskQuestionOutput,
  AskQuestionToolPart,
  PresentReplyOptionsToolPart,
} from "@/components/conductor/conductor-shared";
import { resolveToolPartName } from "@/components/conductor/conductor-shared";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";

const LIVE_REASONING_CHAR_WINDOW = 900;

function liveReasoningText(text: string, isStreaming: boolean): string {
  if (!isStreaming || text.length <= LIVE_REASONING_CHAR_WINDOW) return text;
  const sliceAt = text.length - LIVE_REASONING_CHAR_WINDOW;
  const lineBreak = text.lastIndexOf("\n", text.length - 1);
  const softBreak = text.lastIndexOf("\n", sliceAt);
  if (softBreak > sliceAt) return text.slice(softBreak + 1);
  if (lineBreak > sliceAt) return text.slice(lineBreak + 1);
  return text.slice(sliceAt);
}

export function ConductorReasoningPart({
  part,
  isMessageStreaming,
}: {
  part: ReasoningUIPart;
  isMessageStreaming: boolean;
}) {
  const isStreaming = part.state === "streaming" || (isMessageStreaming && part.state !== "done");
  const text = part.text;
  const liveText = liveReasoningText(text, isStreaming);

  return (
    <Reasoning
      autoCloseDelay={CONDUCTOR_REASONING_COLLAPSE_MS + 180}
      className="mb-2"
      isStreaming={isStreaming}
    >
      <ReasoningTrigger />
      <CollapsibleContent className="conductor-reasoning-collapsible mt-2 text-sm outline-none">
        <ConductorReasoningStream
          isMessageStreaming={isMessageStreaming}
          isStreaming={isStreaming}
          textLength={text.length}
          liveContent={
            <p className="conductor-reasoning-stream__live-text whitespace-pre-wrap break-words">
              {liveText}
            </p>
          }
          settledContent={
            <div className="text-muted-foreground">
              <Streamdown plugins={reasoningStreamdownPlugins}>{text}</Streamdown>
            </div>
          }
        />
      </CollapsibleContent>
    </Reasoning>
  );
}

export function AnsweredPresentReplyOptionsCard({
  input,
  output,
}: {
  input: PresentReplyOptionsInput;
  output: PresentReplyOptionsOutput;
}) {
  const label = input.options.find((option) => option.id === output.selectedOptionId)?.label ?? output.message;
  return (
    <BuilderCompletedCard
      subtitle={label}
      title="Replied"
      variant="emerald"
    />
  );
}

export function AnsweredAskQuestionCard({
  input,
  output,
}: {
  input: AskQuestionInput;
  output: AskQuestionOutput;
}) {
  return (
    <BuilderCompletedCard
      icon={BadgeQuestionMark}
      subtitle={output.skipped ? "Skipped" : output.answerText}
      title={input.question}
      variant="emerald"
    />
  );
}

export function ConductorToolPart({
  part,
  pendingQuestionCallId,
  pendingReplyOptionsCallId,
}: {
  part: DynamicToolUIPart & { toolName?: string; input?: unknown; output?: unknown };
  pendingQuestionCallId: string | null;
  pendingReplyOptionsCallId: string | null;
}) {
  const toolName = resolveToolPartName(part);
  const [open, setOpen] = useState(false);

  if (toolName === "askQuestion") {
    const toolPart = part as AskQuestionToolPart;
    if (toolPart.toolCallId === pendingQuestionCallId) return null;
    if (toolPart.state === "output-available" && toolPart.input && toolPart.output) {
      return (
        <AnsweredAskQuestionCard
          input={toolPart.input}
          output={toolPart.output}
        />
      );
    }
    return null;
  }

  if (toolName === "pickConnectorApp") {
    const input = part.input as { role?: string; question?: string } | undefined;
    const output = part.output as AskQuestionOutput | undefined;
    if (part.toolCallId === pendingQuestionCallId) return null;
    if (part.state === "output-available" && output) {
      return (
        <BuilderCompletedCard
          icon={BadgeQuestionMark}
          subtitle={output.skipped ? "Skipped" : output.answerText}
          title={input?.question || `App selected for ${input?.role ?? "workflow"}`}
          variant="emerald"
        />
      );
    }
    return null;
  }

  if (toolName === "confirmOutcomeBrief") {
    const output = part.output as { action?: string; otherText?: string } | undefined;
    if (part.state === "output-available" && output?.action) {
      return (
        <div className="mb-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {output.action === "confirm" ? "Plan confirmed — ready to build" : `Requested change: ${output.otherText || output.action.replaceAll("_", " ")}`}
        </div>
      );
    }
    return null;
  }

  if (toolName === "presentReplyOptions") {
    const toolPart = part as PresentReplyOptionsToolPart;
    if (toolPart.toolCallId === pendingReplyOptionsCallId) return null;
    if (toolPart.state === "output-available" && toolPart.input && toolPart.output) {
      return (
        <AnsweredPresentReplyOptionsCard
          input={toolPart.input}
          output={toolPart.output}
        />
      );
    }
    return null;
  }

  if (toolName === "connectToolkit") {
    const input = part.input as { toolkit?: string } | undefined;
    const toolkit = typeof input?.toolkit === "string" ? input.toolkit : null;
    if (toolkit) {
      return (
        <BuilderConnectToolkitCard
          output={part.output as { ok?: boolean; toolkit?: string; redirectUrl?: string } | undefined}
          state={part.state}
          toolkit={toolkit}
        />
      );
    }
  }

  const title =
    toolName === "patchLoopSpec"
      ? "Update loop configuration"
      : toolName === "listConnectors"
        ? "Workspace connectors"
        : toolName === "listConnectorCatalog"
          ? "Connector catalogue"
          : toolName === "discoverConnectorsForBlueprint"
              ? "Discover connectors"
              : toolName === "pickConnectorApp"
                ? "Pick connector app"
                : toolName === "presentReplyOptions"
                  ? "Reply options"
                  : toolName === "discoverBindings"
                    ? "Discover bindings"
                    : toolName === "connectToolkit"
                      ? "Start connector OAuth"
                      : toolName === "compileLoop"
                        ? "Compile loop"
                        : toolName === "testRunLoop"
                          ? "Test run"
                          : toolName === "activateLoop"
                            ? "Activate loop"
                            : toolName;

  const summary =
    toolName === "patchLoopSpec"
      ? formatPatchSummary(part.output)
      : toolName === "listConnectors"
        ? formatConnectorSummary(part.output)
        : toolName === "discoverConnectorsForBlueprint" || toolName === "discoverBindings"
          ? formatDiscoverConnectorsSummary(part.output)
          : toolName === "reviewOutcomeBrief"
            ? "Prepared your automation summary for review"
          : toolName === "compileLoop"
            ? formatCompileSummary(part.output)
            : toolName === "testRunLoop"
              ? formatTestRunSummary(part.output)
              : toolName === "activateLoop"
                ? formatActivateSummary(part.output)
                : null;
  const collapsedPreview = summary ?? formatToolInputPreview(toolName, part.input);

  return (
    <Tool open={open} onOpenChange={setOpen} className="mb-2">
      <ToolHeader type="dynamic-tool" toolName={toolName} state={part.state} title={title} />
      {!open && collapsedPreview ? (
        <p className="border-t border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-3 py-2 text-xs leading-relaxed text-[var(--ed-text-2)] line-clamp-3 break-words">
          {collapsedPreview}
        </p>
      ) : null}
      <ToolContent>
        {summary ? <p className="text-sm text-[var(--ed-text-2)]">{summary}</p> : null}
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  );
}

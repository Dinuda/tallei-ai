"use client";

import type { DynamicToolUIPart, ReasoningUIPart } from "ai";
import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";

import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
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

export function ConductorReasoningPart({
  part,
  isMessageStreaming,
}: {
  part: ReasoningUIPart;
  isMessageStreaming: boolean;
}) {
  const isStreaming = part.state === "streaming" || (isMessageStreaming && part.state !== "done");
  return (
    <Reasoning className="mb-2" isStreaming={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
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
      icon={MessageCircleQuestion}
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

  if (toolName === "askQuestion" || toolName === "pickConnectorApp") {
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
          : toolName === "decomposeTask"
            ? "Decompose task"
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

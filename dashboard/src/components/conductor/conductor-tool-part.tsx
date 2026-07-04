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
  AgentTeamRoster,
  AgentTeamRosterPlaceholder,
} from "@/components/conductor/agent-team-roster";
import {
  OutcomeBriefCard,
} from "@/components/conductor/outcome-brief-card";
import {
  buildOutcomeReviewViewModel,
  type LegacyOutcomeReviewSummary,
} from "@/components/conductor/outcome-review-view-model";
import {
  formatActivateSummary,
  formatCompileSummary,
  formatDiscoverConnectorsSummary,
  formatPatchSummary,
  formatTestRunSummary,
  formatToolInputPreview,
} from "@/components/conductor/conductor-tool-formatters";
import type {
  AskQuestionInput,
  AskQuestionOutput,
  AskQuestionToolPart,
  ConfirmOutcomeBriefOutput,
  PickConnectorAppInput,
  PresentAgentTeamOutput,
  PresentReplyOptionsToolPart,
} from "@/components/conductor/conductor-shared";
import {
  DEFAULT_CONNECTOR_PICK_QUESTION,
  connectorLogoUrl,
  findConnectorPickInputForToolCall,
  resolveAskQuestionDisplayAnswer,
  resolveConnectorIconSlug,
  resolveOutcomeBriefCardStatus,
  resolveToolPartName,
} from "@/components/conductor/conductor-shared";
import type { UIMessage } from "ai";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";

export function ConductorReasoningPart({
  part,
}: {
  part: ReasoningUIPart;
}) {
  const isStreaming = part.state === "streaming";
  const text = part.text;

  return (
    <div data-transcript-thought>
      <Reasoning
        autoCloseDelay={CONDUCTOR_REASONING_COLLAPSE_MS + 180}
        isStreaming={isStreaming}
      >
        <ReasoningTrigger />
        <CollapsibleContent className="conductor-reasoning-collapsible mt-2 text-sm outline-none">
          <ConductorReasoningStream
            isStreaming={isStreaming}
            textLength={text.length}
            liveContent={
              <p className="conductor-reasoning-stream__live-text whitespace-pre-wrap break-words">
                {text}
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
    </div>
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
  const isConnectorPick = input.questionId.startsWith("connector-app:");
  const connectorSlug = isConnectorPick ? resolveConnectorIconSlug(output, input.options) : undefined;

  return (
    <BuilderCompletedCard
      icon={isConnectorPick ? undefined : BadgeQuestionMark}
      iconAlt={connectorSlug}
      iconSrc={connectorSlug ? connectorLogoUrl(connectorSlug) : undefined}
      subtitle={resolveAskQuestionDisplayAnswer(input, output)}
      title={input.question}
      variant="emerald"
    />
  );
}

export function ConductorToolPart({
  part,
  messages,
  pendingInteractivePromptCallIds,
  pendingReplyOptionsCallId,
  spec,
}: {
  part: DynamicToolUIPart & { toolName?: string; input?: unknown; output?: unknown };
  messages: UIMessage[];
  pendingInteractivePromptCallIds: Set<string>;
  pendingReplyOptionsCallId: string | null;
  spec: Record<string, unknown> | null;
}) {
  const toolName = resolveToolPartName(part);
  const [open, setOpen] = useState(false);

  if (toolName === "askQuestion") {
    const toolPart = part as AskQuestionToolPart;
    if (pendingInteractivePromptCallIds.has(toolPart.toolCallId)) return null;
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
    const input = part.input as PickConnectorAppInput | undefined;
    const output = part.output as AskQuestionOutput | undefined;
    if (pendingInteractivePromptCallIds.has(part.toolCallId)) return null;
    if (part.state === "output-available" && output && input?.outcomeId) {
      const resolvedInput = findConnectorPickInputForToolCall(
        messages,
        part.toolCallId,
        input.outcomeId,
      );
      if (resolvedInput) {
        return (
          <AnsweredAskQuestionCard
            input={resolvedInput}
            output={output}
          />
        );
      }

      const connectorSlug = resolveConnectorIconSlug(output);
      const connectorLabel = resolveAskQuestionDisplayAnswer(undefined, output);

      return (
        <BuilderCompletedCard
          icon={connectorSlug ? undefined : BadgeQuestionMark}
          iconAlt={connectorSlug}
          iconSrc={connectorSlug ? connectorLogoUrl(connectorSlug) : undefined}
          subtitle={connectorLabel}
          title={DEFAULT_CONNECTOR_PICK_QUESTION}
          variant="emerald"
        />
      );
    }
    return null;
  }

  if (toolName === "presentAgentTeam") {
    const output = part.output as PresentAgentTeamOutput | undefined;
    if (output?.specialists?.length) {
      return (
        <AgentTeamRoster
          streaming={part.state === "input-streaming"}
          team={output}
        />
      );
    }
    return <AgentTeamRosterPlaceholder />;
  }

  if (toolName === "confirmOutcomeBrief") {
    const input = part.input as {
      summary?: LegacyOutcomeReviewSummary;
      options?: Array<{ id: string; value: string; label: string }>;
    } | undefined;
    const output = part.output as ConfirmOutcomeBriefOutput | undefined;

    // Legacy transcripts may still carry a model-generated summary on confirmOutcomeBrief.
    if (input?.summary) {
      const status = resolveOutcomeBriefCardStatus({
        output,
        options: input?.options,
        streaming: part.state === "input-streaming",
        awaitingInput: part.state === "input-available",
      });
      return (
        <OutcomeBriefCard
          status={status}
          streaming={part.state === "input-streaming"}
          viewModel={buildOutcomeReviewViewModel(spec, input.summary)}
        />
      );
    }

    // New flow: roster comes from presentAgentTeam; confirmOutcomeBrief renders no card.
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

  if (["analyzeIntent", "listWorkspaceConnectors", "listTriggers", "listActions", "discoverBindings"].includes(toolName)) {
    return null;
  }

  const title =
    toolName === "patchLoopSpec"
      ? "Making changes..."
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
                      : toolName === "reviewOutcomeBrief"
                        ? "The loop"
                        : toolName === "presentAgentTeam"
                          ? "Agent team"
                      : toolName;

  const summary =
    toolName === "patchLoopSpec"
      ? formatPatchSummary(part.output)
      : toolName === "discoverConnectorsForBlueprint" || toolName === "discoverBindings"
        ? formatDiscoverConnectorsSummary(part.output)
        : toolName === "reviewOutcomeBrief"
          ? "Prepared your automation summary for review"
          : toolName === "presentAgentTeam"
            ? "Assembled your specialist team"
          : toolName === "compileLoop"
            ? formatCompileSummary(part.output)
            : toolName === "testRunLoop"
              ? formatTestRunSummary(part.output)
              : toolName === "activateLoop"
                ? formatActivateSummary(part.output)
                : null;
  const collapsedPreview = summary ?? formatToolInputPreview(toolName, part.input);

  return (
    <Tool open={open} onOpenChange={setOpen}>
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

"use client";

import type { DynamicToolUIPart, ReasoningUIPart } from "ai";
import { AlertTriangle, BadgeQuestionMark, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  resolveConductorToolResultStatus,
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
  const isConnectorPick = input.questionId?.startsWith("connector-app:") ?? false;
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

type BindingDiagnosticView = {
  code?: string;
  message?: string;
  outcome?: string;
  connector?: string;
  rejectedValue?: string;
  expected?: string;
  action?: string;
  options?: Array<{ label: string; value: string; description: string }>;
  technical?: Record<string, unknown>;
};

function safeTechnicalDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const secretPattern = /(token|secret|password|credential|authorization|cookie|api.?key)/i;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    secretPattern.test(key) ? "[REDACTED]" : value,
  ]));
}

function hasLaterBindingResolution(messages: UIMessage[], toolCallId: string): boolean {
  let seen = false;
  for (const message of messages) {
    for (const rawPart of message.parts ?? []) {
      const part = rawPart as { toolCallId?: string; state?: string; output?: unknown };
      if (part.toolCallId === toolCallId) {
        seen = true;
        continue;
      }
      if (!seen || part.state !== "output-available" || !part.output || typeof part.output !== "object") continue;
      const output = part.output as { ok?: boolean; diagnostics?: unknown[]; plan?: unknown };
      if (Array.isArray(output.diagnostics) && output.diagnostics.length === 0) return true;
      if (output.ok === true && output.plan) return true;
    }
  }
  return false;
}

export function BindingDiagnosticsCard({ diagnostics, resolved = false }: { diagnostics: BindingDiagnosticView[]; resolved?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-lg border ${resolved ? "border-slate-200 bg-slate-50 text-slate-700" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
      <div className="flex gap-3 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
        <div className="min-w-0 space-y-3">
          <div>
            <p className="font-medium">{resolved ? "Binding issue resolved" : "Binding setup needs attention"}</p>
            <p className="text-sm">{resolved
              ? "This issue was corrected; its details remain visible for reference."
              : "The workflow cannot continue while these items remain unresolved."}</p>
          </div>
          {diagnostics.map((item, index) => (
            <div className="space-y-1 text-sm" key={`${item.code ?? "binding"}-${index}`}>
              <p className="font-medium">{item.message ?? "A binding could not be verified."}</p>
              {item.action ? <p>{item.action}</p> : null}
              {item.options?.length ? (
                <ul className="list-disc space-y-1 pl-5">
                  {item.options.map((option) => (
                    <li key={option.value}><span className="font-medium">{option.label}</span> — {option.description}</li>
                  ))}
                </ul>
              ) : null}
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-amber-800 underline-offset-2 hover:underline">
                  Technical details
                  <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 rounded border border-amber-200 bg-white/70 p-2 text-xs">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
                    {item.code ? <><dt className="font-medium">Code</dt><dd>{item.code}</dd></> : null}
                    {item.outcome ? <><dt className="font-medium">Outcome</dt><dd>{item.outcome}</dd></> : null}
                    {item.connector ? <><dt className="font-medium">Connector</dt><dd>{item.connector}</dd></> : null}
                    {item.rejectedValue ? <><dt className="font-medium">Rejected</dt><dd>{item.rejectedValue}</dd></> : null}
                    {item.expected ? <><dt className="font-medium">Expected</dt><dd>{item.expected}</dd></> : null}
                  </dl>
                  {Object.keys(safeTechnicalDetails(item.technical)).length ? (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-amber-100/60 p-2">
                      {JSON.stringify(safeTechnicalDetails(item.technical), null, 2)}
                    </pre>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            </div>
          ))}
        </div>
      </div>
    </div>
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
  const diagnosticOutput = part.output && typeof part.output === "object"
    ? part.output as { diagnostics?: BindingDiagnosticView[]; errors?: BindingDiagnosticView[] }
    : null;
  const visibleDiagnostics = diagnosticOutput?.diagnostics?.length
    ? diagnosticOutput.diagnostics
    : toolName === "compileLoop" && diagnosticOutput?.errors?.length
      ? diagnosticOutput.errors
      : null;

  if (visibleDiagnostics) return (
    <BindingDiagnosticsCard
      diagnostics={visibleDiagnostics}
      resolved={hasLaterBindingResolution(messages, part.toolCallId)}
    />
  );

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

  if (["analyzeIntent", "listWorkspaceConnectors", "listTriggers", "listActions", "discoverBindings", "resolveBindings"].includes(toolName)) {
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
  const executionOutput = part.output && typeof part.output === "object"
    ? part.output as {
      ok?: boolean;
      turnOutcome?: string;
      recoveryPhase?: string;
      recoveryReason?: string;
    }
    : null;
  const resultStatus = resolveConductorToolResultStatus(part.output);
  const hasExecutionEnvelope = Boolean(executionOutput
    && typeof (executionOutput as { operationKey?: unknown }).operationKey === "string");

  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader
        type="dynamic-tool"
        toolName={toolName}
        state={part.state}
        title={title}
        resultStatus={resultStatus}
      />
      {!open && collapsedPreview ? (
        <p className="border-t border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-3 py-2 text-xs leading-relaxed text-[var(--ed-text-2)] line-clamp-3 break-words">
          {collapsedPreview}
        </p>
      ) : null}
      <ToolContent>
        {summary ? <p className="text-sm text-[var(--ed-text-2)]">{summary}</p> : null}
        <ToolInput input={part.input} />
        {hasExecutionEnvelope ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-[var(--ed-text-2)] underline-offset-2 hover:underline">
              Technical details
              <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <ToolOutput output={part.output} errorText={part.errorText} />
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <ToolOutput output={part.output} errorText={part.errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}

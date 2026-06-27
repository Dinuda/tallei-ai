"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type UIMessage,
} from "ai";
import { MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import { apiFetch, getStoredWorkspaceId } from "@/lib/api-fetch";
import {
  deriveConductorPromptSuggestions,
  findPendingPresentReplyOptions,
  type ConductorPromptSuggestion,
  type PresentReplyOptionsInput,
  type PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type BindingRow = { connector: string; capability: string; optional?: boolean; role?: string };

type BlueprintOutcome = {
  id: string;
  role: string;
  description: string;
  selectedConnector?: string;
  status: string;
  candidates?: Array<{ connector: string; connected: boolean; rationale?: string }>;
};

type TaskBlueprint = {
  summary?: string;
  outcomes?: BlueprintOutcome[];
};

function readTaskBlueprint(spec: Record<string, unknown> | null): TaskBlueprint | null {
  const blueprint = spec?.taskBlueprint;
  if (!blueprint || typeof blueprint !== "object") return null;
  return blueprint as TaskBlueprint;
}

function outcomeRoleLabel(role: string): string {
  switch (role) {
    case "source": return "Source";
    case "destination": return "Destination";
    case "trigger": return "Trigger";
    case "transform": return "Transform";
    default: return role;
  }
}

function TaskBlueprintPanel({ blueprint }: { blueprint: TaskBlueprint }) {
  const outcomes = blueprint.outcomes ?? [];
  if (outcomes.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Task blueprint</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {blueprint.summary ? (
          <p className="text-sm text-[#3d5c18]">{blueprint.summary}</p>
        ) : null}
        <ul className="space-y-2">
          {outcomes.map((outcome) => (
            <li
              key={outcome.id}
              className="rounded-lg border border-[#e4f5c6] bg-[#f8fdf2] p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[#182506]">
                  {outcomeRoleLabel(outcome.role)}
                </span>
                <span className="text-xs uppercase text-[#7a9a4a]">{outcome.status}</span>
              </div>
              <p className="mt-1 text-[#3d5c18]">{outcome.description}</p>
              {outcome.selectedConnector ? (
                <p className="mt-1 text-xs text-[#182506]">
                  Connector: <span className="font-mono">{outcome.selectedConnector}</span>
                </p>
              ) : null}
              {!outcome.selectedConnector && outcome.candidates && outcome.candidates.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-[#7a9a4a]">
                  {outcome.candidates.slice(0, 3).map((candidate) => (
                    <li key={candidate.connector}>
                      {candidate.connector}
                      {candidate.connected ? " · connected" : " · not connected"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type AskQuestionInput = {
  questionId: string;
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  step?: { index: number; total: number };
};

type AskQuestionOutput = {
  questionId: string;
  answerText: string;
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
  skipped?: boolean;
};

type PickConnectorAppInput = {
  question?: string;
};

type PickConnectorAppToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PickConnectorAppInput;
  output?: AskQuestionOutput;
};

type ConnectorDiscoveryOutput = {
  askOptions?: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  defaultQuestion?: string;
};

type PendingInteractivePrompt = {
  toolCallId: string;
  toolName: "askQuestion" | "pickConnectorApp";
  input: AskQuestionInput;
};

const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should power this loop? Triggers and actions are configured automatically after you pick.";

type PendingPresentReplyOptions = {
  toolCallId: string;
  input: PresentReplyOptionsInput;
};

type PresentReplyOptionsToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PresentReplyOptionsInput;
  output?: PresentReplyOptionsOutput;
};

function isPresentReplyOptionsPart(part: { type: string; toolName?: string }): part is PresentReplyOptionsToolPart {
  return resolveToolPartName(part) === "presentReplyOptions";
}

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

type AskQuestionToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: AskQuestionInput;
  output?: AskQuestionOutput;
};

function isAskQuestionPart(part: { type: string; toolName?: string }): part is AskQuestionToolPart {
  return resolveToolPartName(part) === "askQuestion";
}

function isPickConnectorAppPart(part: { type: string; toolName?: string }): part is PickConnectorAppToolPart {
  return resolveToolPartName(part) === "pickConnectorApp";
}

function findLatestConnectorDiscovery(messages: UIMessage[]): ConnectorDiscoveryOutput | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isToolPart(part.type)) continue;
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "discoverConnectorsForBlueprint") {
        continue;
      }
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.state !== "output-available" || !toolPart.output) continue;
      const output = toolPart.output as ConnectorDiscoveryOutput;
      if (output.askOptions?.length) return output;
    }
  }
  return null;
}

function looksLikeRoleBasedConnectorOptions(options: InteractivePromptOption[]): boolean {
  if (options.some((option) => /-(trigger|source|destination|read|send)\b/i.test(option.label))) {
    return true;
  }
  const appNames = options.map((option) => {
    const split = option.label.split(" - ")[0]?.trim().toLowerCase();
    return split || option.value.toLowerCase();
  });
  return new Set(appNames).size < appNames.length;
}

function buildConnectorPickInput(
  discovery: ConnectorDiscoveryOutput,
  questionOverride?: string,
): AskQuestionInput {
  const askOptions = discovery.askOptions ?? [];
  return {
    questionId: "connector-app",
    question: questionOverride?.trim() || discovery.defaultQuestion || DEFAULT_CONNECTOR_PICK_QUESTION,
    options: askOptions,
    recommendedOptionIds: discovery.recommendedOptionIds ?? askOptions.slice(0, 5).map((option) => option.id),
    allowMultiple: false,
    allowOther: true,
  };
}

function findPendingInteractivePrompt(messages: UIMessage[]): PendingInteractivePrompt | null {
  const discovery = findLatestConnectorDiscovery(messages);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];

      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (pickPart.state === "input-available" && pickPart.output == null) {
          if (!discovery?.askOptions?.length) return null;
          return {
            toolCallId: pickPart.toolCallId,
            toolName: "pickConnectorApp",
            input: buildConnectorPickInput(discovery, pickPart.input?.question),
          };
        }
      }

      if (isAskQuestionPart(part)) {
        const askPart = part as AskQuestionToolPart;
        if (askPart.state === "input-available" && askPart.output == null) {
          const input = askPart.input;
          if (!input?.question || !input.options?.length) continue;

          if (discovery?.askOptions?.length && looksLikeRoleBasedConnectorOptions(input.options)) {
            return {
              toolCallId: askPart.toolCallId,
              toolName: "askQuestion",
              input: buildConnectorPickInput(discovery, input.question),
            };
          }

          return { toolCallId: askPart.toolCallId, toolName: "askQuestion", input };
        }
      }
    }
  }
  return null;
}

function shouldShowThinkingIndicator(
  messages: UIMessage[],
  chatStatus: ChatStatus,
  hasPendingQuestion: boolean,
  forceThinking = false,
): boolean {
  if (forceThinking) return true;
  if (hasPendingQuestion) return false;
  if (chatStatus !== "streaming" && chatStatus !== "submitted") return false;

  const last = messages.at(-1);
  if (!last || last.role === "user") return true;

  const parts = last.parts ?? [];
  const hasStreamingReasoning = parts.some(
    (part) => part.type === "reasoning" && (part as ReasoningUIPart).state === "streaming",
  );
  if (hasStreamingReasoning) return false;

  const hasInProgressTool = parts.some((part) => {
    if (!isToolPart(part.type) || isAskQuestionPart(part)) return false;
    const state = (part as DynamicToolUIPart).state;
    return state !== "output-available" && state !== "output-error";
  });
  if (hasInProgressTool) return false;

  const hasVisibleText = parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  if (hasVisibleText && chatStatus === "streaming") {
    const lastPart = parts.at(-1);
    if (lastPart && isToolPart(lastPart.type) && (lastPart as DynamicToolUIPart).state === "output-available") {
      return true;
    }
    return false;
  }

  return true;
}

function formatCompileSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { ok?: boolean; plan?: { id: string; toolCount?: number }; errors?: unknown[]; error?: string };
  if (row.ok && row.plan) {
    const tools = row.plan.toolCount != null ? `${row.plan.toolCount} tools` : "runnable plan";
    return `Compiled ${tools}. Ready for test run.`;
  }
  if (row.errors?.length) return `Compile failed — ${row.errors.length} blocker(s)`;
  if (row.error) return row.error;
  return null;
}

function formatTestRunSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as {
    ok?: boolean;
    status?: string;
    preview?: string;
    error?: string;
    steps?: Array<{ kind: string; capability?: string }>;
  };
  if (row.ok) {
    const toolStep = row.steps?.find((step) => step.kind === "tool");
    const toolNote = toolStep?.capability ? ` Simulated ${toolStep.capability}.` : "";
    return `Test passed.${toolNote} ${row.preview ?? ""}`.trim();
  }
  if (row.error) return `Test failed: ${row.error}`;
  return null;
}

function formatActivateSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { ok?: boolean; status?: string; error?: string };
  if (row.ok) return `Loop is ${row.status ?? "active"}.`;
  if (row.error) return row.error;
  return null;
}

function formatPatchSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { missingSlots?: string[]; spec?: { bindings?: BindingRow[] } };
  const bindings = row.spec?.bindings?.map((b) => `${b.connector}:${b.capability}`).join(", ");
  const missing = row.missingSlots?.length ? `Still needed: ${row.missingSlots.join(", ")}` : "Ready to compile";
  return bindings ? `Bindings: ${bindings}. ${missing}` : missing;
}

function formatConnectorSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { connectors?: Array<{ slug: string; connected: boolean }> };
  if (!row.connectors?.length) return "No connectors found in workspace.";
  return row.connectors
    .map((c) => `${c.slug}: ${c.connected ? "connected" : "not connected"}`)
    .join(", ");
}

function formatToolInputPreview(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;

  if (toolName === "discoverConnectorsForBlueprint" || toolName === "discoverBindings") {
    const role = typeof row.role === "string" ? row.role : null;
    const outcome = typeof row.outcomeDescription === "string"
      ? row.outcomeDescription
      : typeof row.outcome === "string"
        ? row.outcome
        : null;
    if (toolName === "discoverConnectorsForBlueprint" && Array.isArray(row.outcomes)) {
      return `${row.outcomes.length} outcome${row.outcomes.length === 1 ? "" : "s"}`;
    }
    if (role && outcome) return `${role}: ${outcome}`;
    if (outcome) return outcome;
    if (role) return role;
  }

  if (toolName === "decomposeTask" && typeof row.goal === "string") {
    return row.goal;
  }

  if (toolName === "connectToolkit" && typeof row.toolkit === "string") {
    return row.toolkit;
  }

  return null;
}

function formatDiscoverConnectorsSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as {
    askOptions?: unknown[];
    candidates?: Array<{ connector?: string; actionSlug?: string; name?: string }>;
    selected?: { connector?: string; actionSlug?: string };
  };
  if (row.selected?.connector) {
    return `Selected ${row.selected.connector}${row.selected.actionSlug ? ` · ${row.selected.actionSlug}` : ""}`;
  }
  const count = row.askOptions?.length ?? row.candidates?.length;
  if (count != null) return `${count} option${count === 1 ? "" : "s"} ranked`;
  return null;
}

function ConductorReasoningPart({
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

function AnsweredPresentReplyOptionsCard({
  input,
  output,
}: {
  input: PresentReplyOptionsInput;
  output: PresentReplyOptionsOutput;
}) {
  const label = input.options.find((option) => option.id === output.selectedOptionId)?.label ?? output.message;
  return (
    <div className="my-2 rounded-lg border border-[#e4f5c6] bg-[#f8fdf2] px-4 py-3 text-sm text-[#3d5c18]">
      Replied: <span className="font-medium text-[#182506]">{label}</span>
    </div>
  );
}

function ConductorPromptSuggestionsBar({
  suggestions,
  disabled,
  onSelect,
}: {
  suggestions: ConductorPromptSuggestion[];
  disabled?: boolean;
  onSelect: (suggestion: ConductorPromptSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-[#7a9a4a]">Quick replies</p>
      <Suggestions className="pb-1">
        {suggestions.map((suggestion) => (
          <Suggestion
            key={suggestion.id}
            className="border-[#cce89e] bg-white text-[#182506] hover:border-[#7eb71b] hover:bg-[#f8fdf2]"
            disabled={disabled}
            onClick={() => onSelect(suggestion)}
            suggestion={suggestion.message}
          >
            {suggestion.label}
          </Suggestion>
        ))}
      </Suggestions>
    </div>
  );
}

function AnsweredAskQuestionCard({
  input,
  output,
}: {
  input: AskQuestionInput;
  output: AskQuestionOutput;
}) {
  return (
    <div className="my-2 rounded-lg border border-[#e4f5c6] bg-[#f8fdf2] px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#7eb71b] text-white">
          <MessageCircleQuestion className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#182506]">{input.question}</div>
          <div className="mt-1 text-xs text-[#3d5c18]">
            {output.skipped ? "Skipped" : `Answered: ${output.answerText}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConductorToolPart({
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
  const displayTitle = title;
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
      <ToolHeader type="dynamic-tool" toolName={toolName} state={part.state} title={displayTitle} />
      {!open && collapsedPreview ? (
        <p className="border-t border-[#e5e7eb] bg-[#fafafa] px-3 py-2 text-xs leading-relaxed text-[#3d5c18] line-clamp-3 break-words">
          {collapsedPreview}
        </p>
      ) : null}
      <ToolContent>
        {summary ? <p className="text-sm text-[#3d5c18]">{summary}</p> : null}
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  );
}

type ConductorBuilderLayoutProps = {
  loopId?: string;
  loopName?: string;
  messages: UIMessage[];
  chatStatus: ChatStatus;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (text: string) => void;
  pendingQuestion: PendingInteractivePrompt | null;
  pendingReplyOptions: PendingPresentReplyOptions | null;
  promptSuggestions: ConductorPromptSuggestion[];
  onAskQuestionAnswer: (answer: InteractivePromptAnswer) => void;
  onAskQuestionDismiss: () => void;
  onPromptSuggestionSelect: (suggestion: ConductorPromptSuggestion) => void;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  status: string;
  compiledPlanId: string | null;
  onRun?: () => void;
  thinkingLabel?: string;
  forceThinking?: boolean;
  composerDisabled?: boolean;
};

function ConductorBuilderLayout({
  loopId,
  loopName,
  messages,
  chatStatus,
  input,
  setInput,
  onSubmit,
  pendingQuestion,
  pendingReplyOptions,
  promptSuggestions,
  onAskQuestionAnswer,
  onAskQuestionDismiss,
  onPromptSuggestionSelect,
  spec,
  missingSlots,
  status,
  compiledPlanId,
  onRun,
  thinkingLabel = "Thinking…",
  forceThinking = false,
  composerDisabled = false,
}: ConductorBuilderLayoutProps) {
  const pendingQuestionCallId = pendingQuestion?.toolCallId ?? null;
  const pendingReplyOptionsCallId = pendingReplyOptions?.toolCallId ?? null;
  const readyToCompile = missingSlots.length === 0 && Boolean(spec);
  const taskBlueprint = readTaskBlueprint(spec);
  const showThinking = shouldShowThinkingIndicator(
    messages,
    chatStatus,
    Boolean(pendingQuestion),
    forceThinking,
  );
  const chatBusy = composerDisabled || chatStatus === "streaming" || chatStatus === "submitted";
  const specPanelValue = spec
    ? JSON.stringify(spec, null, 2)
    : "Describe what you want automated in chat. Tallei will name the loop from your first message and build the spec here.";

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#182506]">Conductor</h1>
            {loopName ? (
              <p className="mt-0.5 text-sm text-[#3d5c18]">{loopName}</p>
            ) : (
              <p className="mt-0.5 text-sm text-[#3d5c18]">Create a loop</p>
            )}
          </div>
          <div className="flex gap-3 text-sm">
            {loopId ? (
              <Link href={`/dashboard/loops/${loopId}/runs`} className="text-[#7eb71b] hover:underline">Runs</Link>
            ) : null}
            <Link href="/dashboard/loops" className="text-[#7eb71b] hover:underline">Back</Link>
          </div>
        </div>

        <div className="min-h-[420px] min-w-0 space-y-3 overflow-hidden rounded-xl border border-[#e4f5c6] bg-white p-4">
          {messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "text-right" : "text-left"}>
              {message.role === "user" ? (
                <div className="inline-block max-w-[90%] rounded-lg bg-[#7eb71b] px-3 py-2 text-sm text-white">
                  {message.parts?.map((part, i) => (part.type === "text" ? <span key={i}>{part.text}</span> : null))}
                </div>
              ) : (
                <div className="max-w-full min-w-0 space-y-2">
                  {message.parts?.map((part, i) => {
                    if (part.type === "reasoning") {
                      return (
                        <ConductorReasoningPart
                          key={i}
                          part={part as ReasoningUIPart}
                          isMessageStreaming={chatStatus === "streaming" && message.id === messages.at(-1)?.id}
                        />
                      );
                    }
                    if (part.type === "text") {
                      return (
                        <div key={i} className="inline-block max-w-[90%] rounded-lg bg-[#f8fdf2] px-3 py-2 text-sm text-[#182506]">
                          {part.text}
                        </div>
                      );
                    }
                    if (part.type.startsWith("tool-")) {
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
            </div>
          ))}
          {showThinking ? (
            <div className="pl-1">
              <TranscriptThinkingIndicator label={thinkingLabel} variant="shimmer" />
            </div>
          ) : null}
        </div>

        {pendingQuestion ? (
          <div className="overflow-hidden rounded-xl border border-[#d1d5db] bg-white shadow-sm">
            <InteractivePromptMenu
              allowMultiple={pendingQuestion.input.allowMultiple}
              allowOther={pendingQuestion.input.allowOther ?? true}
              disabled={chatBusy}
              onDismiss={onAskQuestionDismiss}
              onSubmit={onAskQuestionAnswer}
              options={pendingQuestion.input.options}
              placement="composer"
              question={pendingQuestion.input.question}
              rankedAppsLayout={pendingQuestion.input.questionId === "connector-app"}
              recommendedOptionIds={pendingQuestion.input.recommendedOptionIds}
              selectionHint="Search or scroll to find an app"
              step={pendingQuestion.input.step}
            />
          </div>
        ) : null}

        {!pendingQuestion && promptSuggestions.length > 0 ? (
          <ConductorPromptSuggestionsBar
            disabled={chatBusy}
            onSelect={onPromptSuggestionSelect}
            suggestions={promptSuggestions}
          />
        ) : null}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || pendingQuestion || chatBusy) return;
            onSubmit(input.trim());
            setInput("");
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={pendingQuestion ? "Answer the question above to continue…" : "Do this, loop this, connect this..."}
            disabled={chatBusy || Boolean(pendingQuestion)}
          />
          <Button type="submit" disabled={chatBusy || Boolean(pendingQuestion) || !input.trim()}>Send</Button>
        </form>
      </div>

      <div className="space-y-4">
        {taskBlueprint ? <TaskBlueprintPanel blueprint={taskBlueprint} /> : null}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Loop spec</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea readOnly className="min-h-[200px] font-mono text-xs" value={specPanelValue} />
            {readyToCompile ? (
              <p className="mt-2 text-sm font-medium text-[#7eb71b]">Ready to compile</p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Missing: {missingSlots.join(", ") || (loopId ? "—" : "Send your first message to start")}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Status: {status}
              {compiledPlanId ? ` · plan ${compiledPlanId.slice(0, 8)}…` : ""}
            </p>
            {readyToCompile ? (
              <p className="mt-2 text-xs text-[#3d5c18]">
                When you are happy with the spec, ask Conductor to compile, test, and activate it.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => onRun?.()} disabled={!onRun || status !== "active"}>Run now</Button>
          <Link href="/dashboard/approvals" className="text-center text-sm text-[#7eb71b] hover:underline">Approval inbox</Link>
        </div>
      </div>
    </div>
  );
}

function makeUserMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

type ConductorChatBridgeProps = {
  loopId: string;
  pendingPrompt: string | null;
  skipLoopFetch?: boolean;
  bootstrapPromptSentRef: MutableRefObject<boolean>;
  onMessagesChange: (messages: UIMessage[]) => void;
  onStatusChange: (status: ChatStatus) => void;
  onLoopMetaChange: (meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
  }) => void;
  onChatReady: (api: {
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  }) => void;
};

function ConductorChatBridge({
  loopId,
  pendingPrompt,
  skipLoopFetch = false,
  bootstrapPromptSentRef,
  onMessagesChange,
  onStatusChange,
  onLoopMetaChange,
  onChatReady,
}: ConductorChatBridgeProps) {
  const onMessagesChangeRef = useRef(onMessagesChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onLoopMetaChangeRef = useRef(onLoopMetaChange);
  const onChatReadyRef = useRef(onChatReady);

  useEffect(() => { onMessagesChangeRef.current = onMessagesChange; }, [onMessagesChange]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onLoopMetaChangeRef.current = onLoopMetaChange; }, [onLoopMetaChange]);
  useEffect(() => { onChatReadyRef.current = onChatReady; }, [onChatReady]);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/loops/${loopId}/chat`,
      headers: (): Record<string, string> => {
        const ws = getStoredWorkspaceId();
        return ws ? { "X-Workspace-Id": ws } : {};
      },
    }),
    [loopId],
  );

  const { messages, sendMessage, status: chatStatus, addToolOutput, setMessages } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const chatLoadedRef = useRef(false);

  useEffect(() => {
    onChatReadyRef.current({ sendMessage, addToolOutput });
  }, [addToolOutput, sendMessage]);

  useEffect(() => {
    onMessagesChangeRef.current(messages);
  }, [messages]);

  useEffect(() => {
    onStatusChangeRef.current(chatStatus);
  }, [chatStatus]);

  useEffect(() => {
    chatLoadedRef.current = false;

    if (skipLoopFetch) {
      chatLoadedRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      const res = await apiFetch(`/api/loops/${loopId}`);
      const data = await res.json();
      if (cancelled) return;
      if (res.ok) {
        onLoopMetaChangeRef.current({
          loopName: typeof data.loop?.name === "string" ? data.loop.name : undefined,
          spec: data.spec ?? null,
          missingSlots: Array.isArray(data.missingSlots) ? data.missingSlots : [],
          status: data.loop?.status ?? "draft",
          compiledPlanId: data.buildChat?.compiledPlanId ?? null,
        });
        if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) {
          setMessages(data.chatMessages as UIMessage[]);
        }
        chatLoadedRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loopId, setMessages, skipLoopFetch]);

  useEffect(() => {
    if (!chatLoadedRef.current || bootstrapPromptSentRef.current || !pendingPrompt?.trim()) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    if (messages.some((message) => message.role === "user")) {
      bootstrapPromptSentRef.current = true;
      return;
    }
    bootstrapPromptSentRef.current = true;
    void sendMessage({ text: pendingPrompt.trim() });
  }, [bootstrapPromptSentRef, chatStatus, messages, pendingPrompt, sendMessage]);

  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        if (part.type === "tool-patchLoopSpec" && part.state === "output-available") {
          const output = part.output as { spec?: Record<string, unknown>; missingSlots?: string[] };
          onLoopMetaChangeRef.current({
            spec: output.spec ?? null,
            missingSlots: output.missingSlots,
          });
        }
        if (part.type === "tool-compileLoop" && part.state === "output-available") {
          const output = part.output as { ok?: boolean; plan?: { id: string } };
          if (output.ok && output.plan?.id) {
            onLoopMetaChangeRef.current({ compiledPlanId: output.plan.id });
          }
        }
        if (part.type === "tool-activateLoop" && part.state === "output-available") {
          const output = part.output as { ok?: boolean; status?: string };
          if (output.ok) {
            onLoopMetaChangeRef.current({ status: output.status ?? "active" });
          }
        }
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!chatLoadedRef.current || messages.length === 0) return;
    if (chatStatus === "streaming" || chatStatus === "submitted") return;
    const timer = window.setTimeout(() => {
      void apiFetch(`/api/loops/${loopId}/chat`, {
        method: "PUT",
        body: JSON.stringify({ messages }),
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [messages, chatStatus, loopId]);

  return null;
}

function ConductorBuilderSession({ initialLoopId }: { initialLoopId?: string }) {
  const [loopId, setLoopId] = useState<string | null>(initialLoopId ?? null);
  const [loopName, setLoopName] = useState<string | undefined>();
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [missingSlots, setMissingSlots] = useState<string[]>([]);
  const [compiledPlanId, setCompiledPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingUserBubble, setPendingUserBubble] = useState<UIMessage | null>(null);
  const [chatMessages, setChatMessages] = useState<UIMessage[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("ready");
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrapPromptSentRef = useRef(false);
  const chatApiRef = useRef<{
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  } | null>(null);
  const createdInSessionRef = useRef(false);

  const displayMessages = useMemo(() => {
    if (chatMessages.length > 0) return chatMessages;
    if (pendingUserBubble) return [pendingUserBubble];
    return [];
  }, [chatMessages, pendingUserBubble]);

  useEffect(() => {
    if (chatMessages.some((message) => message.role === "user")) {
      setPendingUserBubble(null);
    }
  }, [chatMessages]);

  const pendingQuestion = useMemo(() => findPendingInteractivePrompt(displayMessages), [displayMessages]);
  const pendingReplyOptions = useMemo(
    () => findPendingPresentReplyOptions(displayMessages),
    [displayMessages],
  );

  const promptSuggestions = useMemo(
    () => deriveConductorPromptSuggestions({
      messages: displayMessages,
      missingSlots,
      status,
      hasPendingQuestion: Boolean(pendingQuestion),
      hasPendingReplyOptions: Boolean(pendingReplyOptions),
      chatBusy: creating || chatStatus === "streaming" || chatStatus === "submitted",
      explicitOptions: pendingReplyOptions?.input.options,
    }),
    [
      creating,
      chatStatus,
      displayMessages,
      missingSlots,
      pendingQuestion,
      pendingReplyOptions,
      status,
    ],
  );

  const handleLoopMetaChange = useCallback((meta: {
    loopName?: string;
    spec?: Record<string, unknown> | null;
    missingSlots?: string[];
    status?: string;
    compiledPlanId?: string | null;
  }) => {
    if (meta.loopName !== undefined) setLoopName(meta.loopName);
    if (meta.spec !== undefined) {
      setSpec((prev) => {
        const next = meta.spec ?? null;
        if (prev === next) return prev;
        if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    }
    if (meta.missingSlots !== undefined) {
      setMissingSlots((prev) => (
        prev.length === meta.missingSlots!.length
        && prev.every((slot, index) => slot === meta.missingSlots![index])
          ? prev
          : meta.missingSlots!
      ));
    }
    if (meta.status !== undefined) setStatus((prev) => (prev === meta.status ? prev : meta.status!));
    if (meta.compiledPlanId !== undefined) {
      setCompiledPlanId((prev) => (prev === meta.compiledPlanId ? prev : meta.compiledPlanId ?? null));
    }
  }, []);

  const handleChatReady = useCallback((api: {
    sendMessage: (input: { text: string }) => void;
    addToolOutput: ReturnType<typeof useChat>["addToolOutput"];
  }) => {
    chatApiRef.current = api;
  }, []);

  async function createLoopFromPrompt(text: string) {
    setPendingUserBubble(makeUserMessage(text));
    setCreating(true);
    pendingPromptRef.current = text;
    bootstrapPromptSentRef.current = false;
    try {
      const res = await apiFetch("/api/loops", {
        method: "POST",
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create loop");
      const createdId = data.loop?.id as string | undefined;
      if (!createdId) throw new Error("Failed to create loop");

      createdInSessionRef.current = true;
      setLoopName(typeof data.loop?.name === "string" ? data.loop.name : undefined);
      setSpec(data.spec ?? null);
      setLoopId(createdId);
      window.history.replaceState(null, "", `/dashboard/loops/${createdId}/conductor`);
    } catch (error) {
      pendingPromptRef.current = null;
      bootstrapPromptSentRef.current = false;
      setPendingUserBubble(null);
      alert(error instanceof Error ? error.message : "Failed to create loop");
    } finally {
      setCreating(false);
    }
  }

  function handleSubmit(text: string) {
    if (creating) return;
    if (!loopId) {
      void createLoopFromPrompt(text);
      return;
    }
    chatApiRef.current?.sendMessage({ text });
  }

  function submitAskQuestionAnswer(answer: InteractivePromptAnswer) {
    if (!pendingQuestion || !chatApiRef.current) return;
    void chatApiRef.current.addToolOutput({
      tool: pendingQuestion.toolName,
      toolCallId: pendingQuestion.toolCallId,
      output: {
        questionId: pendingQuestion.input.questionId,
        answerText: answer.answerText,
        selectedOptionIds: answer.selectedOptionIds,
        selectedValues: answer.selectedValues,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
      },
    });
  }

  function dismissAskQuestion() {
    if (!pendingQuestion || !chatApiRef.current) return;
    void chatApiRef.current.addToolOutput({
      tool: pendingQuestion.toolName,
      toolCallId: pendingQuestion.toolCallId,
      output: {
        questionId: pendingQuestion.input.questionId,
        answerText: "skipped",
        selectedOptionIds: [],
        selectedValues: [],
        skipped: true,
      },
    });
  }

  function handlePromptSuggestionSelect(suggestion: ConductorPromptSuggestion) {
    if (creating || chatStatus === "streaming" || chatStatus === "submitted") return;

    if (pendingReplyOptions && chatApiRef.current) {
      void chatApiRef.current.addToolOutput({
        tool: "presentReplyOptions",
        toolCallId: pendingReplyOptions.toolCallId,
        output: {
          selectedOptionId: suggestion.id,
          message: suggestion.message,
        },
      });
      return;
    }

    if (!loopId) {
      void createLoopFromPrompt(suggestion.message);
      return;
    }
    chatApiRef.current?.sendMessage({ text: suggestion.message });
  }

  async function handleRun() {
    if (!loopId) return;
    const res = await apiFetch(`/api/loops/${loopId}/runs`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) alert(data.error ?? "Run failed");
    else if (data.run?.id) {
      window.location.href = `/dashboard/loops/${loopId}/runs/${data.run.id}`;
    }
  }

  const effectiveChatStatus: ChatStatus = creating
    ? "submitted"
    : loopId
      ? chatStatus
      : "ready";

  return (
    <>
      {loopId ? (
        <ConductorChatBridge
          loopId={loopId}
          pendingPrompt={pendingPromptRef.current}
          skipLoopFetch={createdInSessionRef.current}
          bootstrapPromptSentRef={bootstrapPromptSentRef}
          onMessagesChange={setChatMessages}
          onStatusChange={setChatStatus}
          onLoopMetaChange={handleLoopMetaChange}
          onChatReady={handleChatReady}
        />
      ) : null}
      <ConductorBuilderLayout
        loopId={loopId ?? undefined}
        loopName={loopName}
        messages={displayMessages}
        chatStatus={effectiveChatStatus}
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
        pendingQuestion={pendingQuestion}
        pendingReplyOptions={pendingReplyOptions}
        promptSuggestions={promptSuggestions}
        onAskQuestionAnswer={submitAskQuestionAnswer}
        onAskQuestionDismiss={dismissAskQuestion}
        onPromptSuggestionSelect={handlePromptSuggestionSelect}
        spec={spec}
        missingSlots={missingSlots}
        status={status}
        compiledPlanId={compiledPlanId}
        onRun={loopId ? () => void handleRun() : undefined}
        thinkingLabel={creating ? "Creating loop…" : "Thinking…"}
        forceThinking={creating}
        composerDisabled={creating}
      />
    </>
  );
}

export function ConductorBuilder({ loopId: initialLoopId }: { loopId?: string }) {
  return <ConductorBuilderSession initialLoopId={initialLoopId} />;
}

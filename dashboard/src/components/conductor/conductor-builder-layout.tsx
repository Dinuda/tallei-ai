"use client";

import type { UIMessage } from "ai";
import Link from "next/link";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
} from "@/components/ai-elements/interactive-prompt-menu";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { BuilderConnectorPrompt } from "@/components/conductor/builder-connector-prompt";
import { ConductorBuilderChat } from "@/components/conductor/conductor-builder-chat";
import type {
  ChatStatus,
  PendingInteractivePrompt,
  TaskBlueprint,
} from "@/components/conductor/conductor-shared";
import {
  outcomeRoleLabel,
  promptVariantForQuestion,
  readTaskBlueprint,
  shouldShowThinkingIndicator,
} from "@/components/conductor/conductor-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConductorPromptSuggestion } from "@/lib/conductor-prompt-suggestions";

function TaskBlueprintPanel({ blueprint }: { blueprint: TaskBlueprint }) {
  const outcomes = blueprint.outcomes ?? [];
  if (outcomes.length === 0) return null;

  return (
    <Card className="rounded-none border-[var(--ed-border-light)] shadow-none">
      <CardHeader>
        <CardTitle className="text-base text-[var(--ed-text)]">Task blueprint</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {blueprint.summary ? (
          <p className="text-sm text-[var(--ed-text-2)]">{blueprint.summary}</p>
        ) : null}
        <ul className="space-y-2">
          {outcomes.map((outcome) => (
            <li
              key={outcome.id}
              className="border border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[var(--ed-text)]">
                  {outcomeRoleLabel(outcome.role)}
                </span>
                <span className="text-xs uppercase text-[var(--ed-text-3)]">{outcome.status}</span>
              </div>
              <p className="mt-1 text-[var(--ed-text-2)]">{outcome.description}</p>
              {outcome.selectedConnector ? (
                <p className="mt-1 text-xs text-[var(--ed-text)]">
                  Connector: <span className="font-mono">{outcome.selectedConnector}</span>
                </p>
              ) : null}
              {!outcome.selectedConnector && outcome.candidates && outcome.candidates.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-[var(--ed-text-3)]">
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
      <p className="text-xs font-medium text-[var(--ed-text-3)]">Quick replies</p>
      <Suggestions className="pb-1">
        {suggestions.map((suggestion) => (
          <Suggestion
            key={suggestion.id}
            className="border-[var(--ed-border-light)] bg-white text-[var(--ed-text)] hover:border-[var(--ed-accent-border)] hover:bg-[var(--ed-surface-hover)]"
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

export type ConductorBuilderLayoutProps = {
  loopId?: string;
  loopName?: string;
  messages: UIMessage[];
  chatStatus: ChatStatus;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (text: string) => void;
  pendingQuestion: PendingInteractivePrompt | null;
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
  pendingReplyOptionsCallId?: string | null;
};

export function ConductorBuilderLayout({
  loopId,
  loopName,
  messages,
  chatStatus,
  input,
  setInput,
  onSubmit,
  pendingQuestion,
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
  pendingReplyOptionsCallId = null,
}: ConductorBuilderLayoutProps) {
  const pendingQuestionCallId = pendingQuestion?.toolCallId ?? null;
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

  const isConnectorPick = pendingQuestion?.input.questionId === "connector-app";
  const promptVariant = pendingQuestion
    ? promptVariantForQuestion(pendingQuestion.input.questionId)
    : "neutral";

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--ed-text)]" style={{ fontFamily: "var(--font-title)" }}>
              Conductor
            </h1>
            {loopName ? (
              <p className="mt-0.5 text-sm text-[var(--ed-text-2)]">{loopName}</p>
            ) : (
              <p className="mt-0.5 text-sm text-[var(--ed-text-2)]">Create a loop</p>
            )}
          </div>
          <div className="flex gap-3 text-sm">
            {loopId ? (
              <Link href={`/dashboard/loops/${loopId}/runs`} className="text-[var(--ed-accent)] hover:underline">
                Runs
              </Link>
            ) : null}
            <Link href="/dashboard/loops" className="text-[var(--ed-accent)] hover:underline">
              Back
            </Link>
          </div>
        </div>

        <ConductorBuilderChat
          chatStatus={chatStatus}
          messages={messages}
          pendingQuestionCallId={pendingQuestionCallId}
          pendingReplyOptionsCallId={pendingReplyOptionsCallId}
          showThinking={showThinking}
          thinkingLabel={thinkingLabel}
        />

        {pendingQuestion ? (
          isConnectorPick ? (
            <BuilderConnectorPrompt
              allowMultiple={pendingQuestion.input.allowMultiple}
              allowOther={pendingQuestion.input.allowOther ?? true}
              disabled={chatBusy}
              onDismiss={onAskQuestionDismiss}
              onSubmit={onAskQuestionAnswer}
              options={pendingQuestion.input.options}
              question={pendingQuestion.input.question}
              recommendedOptionIds={pendingQuestion.input.recommendedOptionIds}
              selectionHint="Search or scroll to find an app"
              step={pendingQuestion.input.step}
            />
          ) : (
            <div className="overflow-hidden border border-[var(--ed-border-light)] bg-white shadow-sm">
              <InteractivePromptMenu
                allowMultiple={pendingQuestion.input.allowMultiple}
                allowOther={pendingQuestion.input.allowOther ?? true}
                disabled={chatBusy}
                onDismiss={onAskQuestionDismiss}
                onSubmit={onAskQuestionAnswer}
                options={pendingQuestion.input.options}
                placement="composer"
                question={pendingQuestion.input.question}
                recommendedOptionIds={pendingQuestion.input.recommendedOptionIds}
                step={pendingQuestion.input.step}
                variant={promptVariant}
              />
            </div>
          )
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
          <Button type="submit" disabled={chatBusy || Boolean(pendingQuestion) || !input.trim()}>
            Send
          </Button>
        </form>
      </div>

      <div className="space-y-4">
        {taskBlueprint ? <TaskBlueprintPanel blueprint={taskBlueprint} /> : null}
        <Card className="rounded-none border-[var(--ed-border-light)] shadow-none">
          <CardHeader>
            <CardTitle className="text-base text-[var(--ed-text)]">Loop spec</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea readOnly className="min-h-[200px] font-mono text-xs" value={specPanelValue} />
            {readyToCompile ? (
              <p className="mt-2 text-sm font-medium text-[var(--builder-emerald-accent)]">Ready to compile</p>
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
              <p className="mt-2 text-xs text-[var(--ed-text-2)]">
                When you are happy with the spec, ask Conductor to compile, test, and activate it.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => onRun?.()} disabled={!onRun || status !== "active"}>
            Run now
          </Button>
          <Link href="/dashboard/approvals" className="text-center text-sm text-[var(--ed-accent)] hover:underline">
            Approval inbox
          </Link>
        </div>
      </div>
    </div>
  );
}

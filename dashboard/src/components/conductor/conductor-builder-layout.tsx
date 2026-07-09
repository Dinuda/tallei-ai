"use client";

import type { UIMessage } from "ai";
import { History } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
} from "@/components/ai-elements/interactive-prompt-menu";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import { BuilderConnectorPrompt } from "@/components/conductor/builder-connector-prompt";
import { BuilderOutcomeBriefPrompt } from "@/components/conductor/builder-outcome-brief-prompt";
import { ConductorBuilderChat } from "@/components/conductor/conductor-builder-chat";
import { ConductorSpecSheet, type LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";
import { ConductorUsageIndicator } from "@/components/conductor/conductor-usage-indicator";
import { LoopSuggestionCards } from "@/components/conductor/loop-suggestion-cards";
import type {
  ChatStatus,
  PendingInteractivePrompt,
  PendingOutcomeBrief,
} from "@/components/conductor/conductor-shared";
import {
  promptVariantForQuestion,
  shouldShowThinkingIndicator,
  validateConductorComposerMessage,
} from "@/components/conductor/conductor-shared";
import type { ConductorPromptSuggestion } from "@/lib/conductor-prompt-suggestions";
import type { ConductorTranscriptError } from "@/lib/conductor-transcript-error";
import {
  emptyBuilderLiveUsage,
  type BuilderLiveUsage,
} from "@/lib/loop-builder-usage";

export type ConductorBuilderLayoutProps = {
  loopId?: string;
  loopName?: string;
  messages: UIMessage[];
  chatStatus: ChatStatus;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (text: string, meta?: { loopName?: string }) => void;
  onStop?: () => void;
  onRetry?: () => void;
  pendingQuestions: PendingInteractivePrompt[];
  questionSubmitBusy?: boolean;
  questionBatchMode?: boolean;
  pendingOutcomeBrief: PendingOutcomeBrief | null;
  promptSuggestions: ConductorPromptSuggestion[];
  promptSuggestionsQuestion: string;
  onAskQuestionAnswer: (prompt: PendingInteractivePrompt, answer: InteractivePromptAnswer) => void;
  onAskQuestionDismiss: (prompt: PendingInteractivePrompt) => void;
  onOutcomeBriefAnswer: (answer: InteractivePromptAnswer) => void;
  onPromptSuggestionsSubmit: (answer: InteractivePromptAnswer) => void;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  status: string;
  compiledPlanId: string | null;
  eventTrigger?: LoopEventTriggerStatus | null;
  onRun?: () => void;
  thinkingLabel?: string;
  forceThinking?: boolean;
  composerDisabled?: boolean;
  sendBlocked?: boolean;
  pendingReplyOptionsCallId?: string | null;
  chatUsage?: BuilderLiveUsage;
  transcriptError?: ConductorTranscriptError | null;
};

function ComposerFooterActions({
  loopId,
  loopName,
  spec,
  missingSlots,
  status,
  compiledPlanId,
  eventTrigger,
  readyToCompile,
  onRun,
  chatUsage,
  trailing,
}: {
  loopId?: string;
  loopName?: string;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  status: string;
  compiledPlanId: string | null;
  eventTrigger?: LoopEventTriggerStatus | null;
  readyToCompile: boolean;
  onRun?: () => void;
  chatUsage: BuilderLiveUsage;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--cb-border-light,#e5e7eb)] px-4 py-2">
      <div className="flex items-center gap-2">
        <ConductorSpecSheet
          compiledPlanId={compiledPlanId}
          eventTrigger={eventTrigger}
          loopId={loopId}
          loopName={loopName}
          missingSlots={missingSlots}
          onRun={onRun}
          readyToCompile={readyToCompile}
          spec={spec}
          status={status}
        />
        <ConductorUsageIndicator usage={chatUsage} />
        {loopId ? (
          <Link
            className="conductor-builder-page__spec-trigger"
            href={`/dashboard/loops/${loopId}/runs`}
          >
            <History className="size-3.5" />
            <span>Runs</span>
          </Link>
        ) : null}
      </div>
      {trailing ? <div className="flex items-center">{trailing}</div> : null}
    </div>
  );
}

export function ConductorBuilderLayout({
  loopId,
  loopName,
  messages,
  chatStatus,
  input,
  setInput,
  onSubmit,
  onStop,
  onRetry,
  pendingQuestions,
  questionSubmitBusy = false,
  questionBatchMode = false,
  pendingOutcomeBrief,
  promptSuggestions,
  promptSuggestionsQuestion,
  onAskQuestionAnswer,
  onAskQuestionDismiss,
  onOutcomeBriefAnswer,
  onPromptSuggestionsSubmit,
  spec,
  missingSlots,
  status,
  compiledPlanId,
  eventTrigger,
  onRun,
  thinkingLabel = "Thinking…",
  forceThinking = false,
  composerDisabled = false,
  sendBlocked = false,
  pendingReplyOptionsCallId = null,
  chatUsage = emptyBuilderLiveUsage(),
  transcriptError = null,
}: ConductorBuilderLayoutProps) {
  const pendingInteractivePromptCallIds = useMemo(
    () => new Set(pendingQuestions.map((prompt) => prompt.toolCallId)),
    [pendingQuestions],
  );
  const pendingQuestionStepsRef = useRef(new Map<string, { index: number; total: number }>());
  for (const prompt of pendingQuestions) {
    if (prompt.input.step && !pendingQuestionStepsRef.current.has(prompt.toolCallId)) {
      pendingQuestionStepsRef.current.set(prompt.toolCallId, prompt.input.step);
    }
  }
  const activePendingQuestion = pendingQuestions[0] ?? null;
  const activePendingQuestionStep = activePendingQuestion
    ? pendingQuestionStepsRef.current.get(activePendingQuestion.toolCallId) ?? activePendingQuestion.input.step
    : undefined;
  const readyToCompile = missingSlots.length === 0 && Boolean(spec);
  const showThinking = shouldShowThinkingIndicator(
    messages,
    chatStatus,
    Boolean(pendingQuestions.length || pendingOutcomeBrief),
    forceThinking,
  );
  const chatBusy = composerDisabled || chatStatus === "streaming" || chatStatus === "submitted";
  const composerInteractiveReady = chatStatus === "ready" && !composerDisabled;
  const showComposerBusy = chatBusy && pendingQuestions.length === 0 && !pendingOutcomeBrief;
  const showTranscriptThinking = showThinking && !showComposerBusy;
  const suggestionsKey = promptSuggestions.map((suggestion) => suggestion.id).join("|");
  const [dismissedSuggestionsKey, setDismissedSuggestionsKey] = useState<string | null>(null);
  const showPromptSuggestions = promptSuggestions.length > 0
    && promptSuggestionsQuestion.trim().length > 0
    && dismissedSuggestionsKey !== suggestionsKey;
  const suggestionOptions = useMemo(
    () => promptSuggestions.map((suggestion) => ({
      id: suggestion.id,
      label: suggestion.label,
      value: suggestion.message,
    })),
    [promptSuggestions],
  );
  const recommendedSuggestionIds = useMemo(
    () => (promptSuggestions[0] ? [promptSuggestions[0].id] : []),
    [promptSuggestions],
  );

  const showComposerSubmit = !pendingOutcomeBrief
    && pendingQuestions.length === 0
    && !(composerInteractiveReady && showPromptSuggestions);

  const chatErrorToastShownRef = useRef(false);

  useEffect(() => {
    if (chatStatus === "error" && onRetry) {
      if (!chatErrorToastShownRef.current) {
        chatErrorToastShownRef.current = true;
        toast.error("The response was interrupted.", {
          id: "conductor-chat-error",
          action: {
            label: "Retry",
            onClick: onRetry,
          },
        });
      }
      return;
    }
    chatErrorToastShownRef.current = false;
    toast.dismiss("conductor-chat-error");
  }, [chatStatus, onRetry]);

  const submitComposerText = useCallback((text: string, meta?: { loopName?: string }) => {
    if (chatBusy) return;
    if (sendBlocked) {
      toast.error("Answer the pending question before sending a message.");
      return;
    }
    const validationError = validateConductorComposerMessage(text);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    onSubmit(text.trim(), meta);
    setInput("");
  }, [chatBusy, onSubmit, sendBlocked, setInput]);

  const emptyState = useMemo(
    () => (!loopId ? (
      <LoopSuggestionCards
        className="max-w-3xl"
        onSelect={({ name, message }) => submitComposerText(message, { loopName: name })}
      />
    ) : undefined),
    [loopId, submitComposerText],
  );

  return (
    <div className="conductor-builder-page">
      <div aria-hidden className="conductor-builder-page__gradient" />
      <div className="conductor-builder-page__inner">
        <div className="conductor-builder-page__conversation">
          <ConductorBuilderChat
            chatStatus={chatStatus}
            emptyState={emptyState}
            messages={messages}
            onRetry={onRetry}
            pendingInteractivePromptCallIds={pendingInteractivePromptCallIds}
            pendingReplyOptionsCallId={pendingReplyOptionsCallId}
            spec={spec}
            showThinking={showTranscriptThinking}
            thinkingLabel={thinkingLabel}
            pauseReasoningForUserInput={Boolean(pendingQuestions.length || pendingOutcomeBrief)}
            transcriptError={transcriptError}
          />
        </div>

        <div className="conductor-builder-page__composer-wrap">
          <div className="conductor-builder-page__composer-inner">
            <motion.div className="conductor-builder-page__composer-surface flex flex-col">
              <div className="min-h-0 flex-1">
              <AnimatePresence initial={false} mode="popLayout">
                {pendingOutcomeBrief ? (
                  <motion.div
                    key={`outcome-brief-${pendingOutcomeBrief.toolCallId}`}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <BuilderOutcomeBriefPrompt
                        confirmPrompt={pendingOutcomeBrief.confirmPrompt}
                        disabled={chatBusy}
                        submitting={chatBusy}
                        onSubmit={onOutcomeBriefAnswer}
                      />
                    </motion.div>
                ) : activePendingQuestion ? (
                  <motion.div
                    key={`pending-question-${activePendingQuestion.toolCallId}`}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {activePendingQuestion.input.questionId?.startsWith("connector-app:") ? (
                      <BuilderConnectorPrompt
                        allowMultiple={activePendingQuestion.input.allowMultiple}
                        allowOther={activePendingQuestion.input.allowOther ?? true}
                        disabled={chatBusy || questionSubmitBusy}
                        onDismiss={() => onAskQuestionDismiss(activePendingQuestion)}
                        onSubmit={(answer) => onAskQuestionAnswer(activePendingQuestion, answer)}
                        options={activePendingQuestion.input.options}
                        question={activePendingQuestion.input.question}
                        recommendedOptionIds={activePendingQuestion.input.recommendedOptionIds}
                        selectionHint="Search or scroll to find an app"
                        step={activePendingQuestionStep}
                      />
                    ) : (
                      <InteractivePromptMenu
                        allowMultiple={activePendingQuestion.input.allowMultiple}
                        allowOther={activePendingQuestion.input.allowOther ?? true}
                        disabled={chatBusy || questionSubmitBusy}
                        onDismiss={() => onAskQuestionDismiss(activePendingQuestion)}
                        onSubmit={(answer) => onAskQuestionAnswer(activePendingQuestion, answer)}
                        options={activePendingQuestion.input.options}
                        placement="composer"
                        question={activePendingQuestion.input.question}
                        recommendedOptionIds={activePendingQuestion.input.recommendedOptionIds}
                        selectionHint={questionBatchMode
                          ? "Answer each question — your answers submit together at the end"
                          : undefined}
                        step={activePendingQuestionStep}
                        submitting={questionSubmitBusy}
                        variant={promptVariantForQuestion(activePendingQuestion.input.questionId)}
                      />
                    )}
                  </motion.div>
                ) : composerInteractiveReady && showPromptSuggestions ? (
                  <motion.div
                    key="prompt-suggestions"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <InteractivePromptMenu
                      allowOther
                      disabled={chatBusy}
                      submitting={chatBusy}
                      onDismiss={() => setDismissedSuggestionsKey(suggestionsKey)}
                      onSubmit={onPromptSuggestionsSubmit}
                      options={suggestionOptions}
                      placement="composer"
                      question={promptSuggestionsQuestion}
                      recommendedOptionIds={recommendedSuggestionIds}
                      selectionHint="Pick an option, or describe your own approach below"
                      variant="neutral"
                    />
                  </motion.div>
                ) : showComposerBusy ? (
                  <motion.div
                    key="composer-busy"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div
                      aria-label={thinkingLabel}
                      className="relative flex min-h-[var(--cb-composer-min-h,56px)] items-center px-4 py-5"
                      role="status"
                    >
                      <TranscriptThinkingIndicator label={thinkingLabel} />
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="prompt-input"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div className="relative" data-conductor-prompt-input>
                      <PromptInput
                        className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-3 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0"
                        onSubmit={({ text }) => {
                          submitComposerText(text);
                        }}
                      >
                        <PromptInputTextarea
                          className="min-h-0 pr-12"
                          onChange={(event) => setInput(event.currentTarget.value)}
                          placeholder={
                            messages.some((message) => message.role === "assistant")
                              ? "Reply or ask to change something…"
                              : "What should this loop do? (e.g. Help with support tickets, Weekly team digest)"
                          }
                          value={input}
                        />
                      </PromptInput>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              </div>
              <ComposerFooterActions
                chatUsage={chatUsage}
                compiledPlanId={compiledPlanId}
                eventTrigger={eventTrigger}
                loopId={loopId}
                loopName={loopName}
                missingSlots={missingSlots}
                onRun={onRun}
                readyToCompile={readyToCompile}
                spec={spec}
                status={status}
                trailing={
                  showComposerSubmit && onStop ? (
                    <PromptInputSubmit
                      className="data-[conductor-submit]"
                      data-conductor-submit
                      disabled={!showComposerBusy && !input.trim()}
                      onStop={onStop}
                      status={chatStatus}
                    />
                  ) : null
                }
              />
            </motion.div>
          </div>
        </div>

        <div className="conductor-builder-page__footer">
          <p>Tallei can make mistakes. Check important info.</p>
        </div>
      </div>
    </div>
  );
}

"use client";

import type { UIMessage } from "ai";
import { History, RefreshCw } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
} from "@/components/ai-elements/interactive-prompt-menu";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import { BuilderConnectorPrompt } from "@/components/conductor/builder-connector-prompt";
import { BuilderOutcomeBriefPrompt } from "@/components/conductor/builder-outcome-brief-prompt";
import { ConductorBuilderChat } from "@/components/conductor/conductor-builder-chat";
import { ConductorSpecSheet, type LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";
import { LoopSuggestionCards } from "@/components/conductor/loop-suggestion-cards";
import type {
  ChatStatus,
  PendingInteractivePrompt,
  PendingOutcomeBrief,
} from "@/components/conductor/conductor-shared";
import {
  promptVariantForQuestion,
  shouldShowThinkingIndicator,
} from "@/components/conductor/conductor-shared";
import type { ConductorPromptSuggestion } from "@/lib/conductor-prompt-suggestions";

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
};

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
  const showPromptSuggestions = promptSuggestions.length > 0 && dismissedSuggestionsKey !== suggestionsKey;
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

  const submitComposerText = useCallback((text: string, meta?: { loopName?: string }) => {
    const answerText = text.trim();
    if (!answerText || sendBlocked || chatBusy) return;
    onSubmit(answerText, meta);
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
            pendingInteractivePromptCallIds={pendingInteractivePromptCallIds}
            pendingReplyOptionsCallId={pendingReplyOptionsCallId}
            spec={spec}
            showThinking={showTranscriptThinking}
            thinkingLabel={thinkingLabel}
          />
        </div>

        <div className="conductor-builder-page__composer-wrap">
          <div className="conductor-builder-page__composer-inner">
            <AnimatePresence initial={false}>
              {chatStatus === "error" && onRetry ? (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 flex justify-center"
                  exit={{ opacity: 0, y: 6 }}
                  initial={{ opacity: 0, y: 6 }}
                  role="alert"
                >
                  <div className="flex items-center gap-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 shadow-sm">
                    <span>The response was interrupted.</span>
                    <button
                      className="inline-flex items-center gap-1.5 bg-red-900 px-3 py-1.5 font-medium text-white transition-colors hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
                      onClick={onRetry}
                      type="button"
                    >
                      <RefreshCw className="size-4" aria-hidden />
                      Retry
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <motion.div className="conductor-builder-page__composer-surface">
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
                    {activePendingQuestion.input.questionId.startsWith("connector-app:") ? (
                      <BuilderConnectorPrompt
                        allowMultiple={activePendingQuestion.input.allowMultiple}
                        allowOther={activePendingQuestion.input.allowOther ?? true}
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
                        onDismiss={() => onAskQuestionDismiss(activePendingQuestion)}
                        onSubmit={(answer) => onAskQuestionAnswer(activePendingQuestion, answer)}
                        options={activePendingQuestion.input.options}
                        placement="composer"
                        question={activePendingQuestion.input.question}
                        recommendedOptionIds={activePendingQuestion.input.recommendedOptionIds}
                        step={activePendingQuestionStep}
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
                      className="flex min-h-[var(--cb-composer-min-h,56px)] items-center px-4 py-5"
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
                        className="[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:px-4 [&_[data-slot=input-group]]:pt-3 [&_[data-slot=input-group]]:pb-12 [&_[data-slot=input-group]]:min-h-[56px] [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:focus-within:!border-0 [&_[data-slot=input-group]]:!ring-0"
                        onSubmit={({ text }) => {
                          submitComposerText(text);
                        }}
                      >
                        <PromptInputTextarea
                          className="min-h-0 pr-12 pb-2"
                          onChange={(event) => setInput(event.currentTarget.value)}
                          placeholder="What should this loop do? (e.g. Help with support tickets, Weekly team digest)"
                          value={input}
                        />

                        <div className="absolute bottom-3 left-4 flex items-center gap-2">
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

                        <PromptInputFooter className="absolute bottom-2 right-2 z-10 w-auto p-0">
                          <PromptInputSubmit
                            className="data-[conductor-submit]"
                            data-conductor-submit
                            onStop={onStop}
                            status={chatStatus}
                          />
                        </PromptInputFooter>
                      </PromptInput>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
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

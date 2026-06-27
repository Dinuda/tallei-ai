"use client";

import type { UIMessage } from "ai";
import { History } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo } from "react";

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
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { TranscriptThinkingIndicator } from "@/components/ai-elements/transcript-thinking";
import { BuilderConnectorPrompt } from "@/components/conductor/builder-connector-prompt";
import { ConductorBuilderChat } from "@/components/conductor/conductor-builder-chat";
import { ConductorSpecSheet, type LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";
import { LoopSuggestionCards } from "@/components/conductor/loop-suggestion-cards";
import type {
  ChatStatus,
  PendingInteractivePrompt,
} from "@/components/conductor/conductor-shared";
import {
  promptVariantForQuestion,
  shouldShowThinkingIndicator,
} from "@/components/conductor/conductor-shared";
import type { ConductorPromptSuggestion } from "@/lib/conductor-prompt-suggestions";

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
    <div className="border-b border-[var(--cb-border-light,#e5e7eb)] px-3 py-2">
      <Suggestions className="flex-wrap gap-1.5 pb-0">
        {suggestions.map((suggestion) => (
          <Suggestion
            key={suggestion.id}
            className="border-[var(--cb-border-light,#e5e7eb)] bg-white text-[var(--cb-text,#111827)] hover:border-[#9ca3af] hover:bg-slate-50"
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
  onStop?: () => void;
  pendingQuestion: PendingInteractivePrompt | null;
  promptSuggestions: ConductorPromptSuggestion[];
  onAskQuestionAnswer: (answer: InteractivePromptAnswer) => void;
  onAskQuestionDismiss: () => void;
  onPromptSuggestionSelect: (suggestion: ConductorPromptSuggestion) => void;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  status: string;
  compiledPlanId: string | null;
  eventTrigger?: LoopEventTriggerStatus | null;
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
  onStop,
  pendingQuestion,
  promptSuggestions,
  onAskQuestionAnswer,
  onAskQuestionDismiss,
  onPromptSuggestionSelect,
  spec,
  missingSlots,
  status,
  compiledPlanId,
  eventTrigger,
  onRun,
  thinkingLabel = "Thinking…",
  forceThinking = false,
  composerDisabled = false,
  pendingReplyOptionsCallId = null,
}: ConductorBuilderLayoutProps) {
  const pendingQuestionCallId = pendingQuestion?.toolCallId ?? null;
  const readyToCompile = missingSlots.length === 0 && Boolean(spec);
  const showThinking = shouldShowThinkingIndicator(
    messages,
    chatStatus,
    Boolean(pendingQuestion),
    forceThinking,
  );
  const chatBusy = composerDisabled || chatStatus === "streaming" || chatStatus === "submitted";
  const composerInteractiveReady = chatStatus === "ready" && !composerDisabled;
  const showComposerBusy = chatBusy && !pendingQuestion;
  const showTranscriptThinking = showThinking && !showComposerBusy;

  const isConnectorPick = pendingQuestion?.input.questionId === "connector-app";
  const promptVariant = pendingQuestion
    ? promptVariantForQuestion(pendingQuestion.input.questionId)
    : "neutral";

  const submitComposerText = useCallback((text: string) => {
    const answerText = text.trim();
    if (!answerText || pendingQuestion || chatBusy) return;
    onSubmit(answerText);
    setInput("");
  }, [chatBusy, onSubmit, pendingQuestion, setInput]);

  const emptyState = useMemo(
    () => (!loopId ? <LoopSuggestionCards className="max-w-3xl" onSelect={submitComposerText} /> : undefined),
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
            pendingQuestionCallId={pendingQuestionCallId}
            pendingReplyOptionsCallId={pendingReplyOptionsCallId}
            showThinking={showTranscriptThinking}
            thinkingLabel={thinkingLabel}
          />
        </div>

        <div className="conductor-builder-page__composer-wrap">
          <div className="conductor-builder-page__composer-inner">
            <motion.div className="conductor-builder-page__composer-surface">
              <AnimatePresence initial={false} mode="popLayout">
                {composerInteractiveReady && pendingQuestion ? (
                  <motion.div
                    key={isConnectorPick ? "connector-pick" : `prompt-${pendingQuestion.toolCallId}`}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {isConnectorPick ? (
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
                    )}
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
                    {!pendingQuestion && promptSuggestions.length > 0 ? (
                      <ConductorPromptSuggestionsBar
                        disabled={chatBusy}
                        onSelect={onPromptSuggestionSelect}
                        suggestions={promptSuggestions}
                      />
                    ) : null}

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
                          placeholder="Describe the outcome you want (e.g. urgent tickets flagged, drafts ready for review)..."
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

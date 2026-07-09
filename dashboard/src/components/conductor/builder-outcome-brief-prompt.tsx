"use client";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";

export function BuilderOutcomeBriefPrompt({
  confirmPrompt,
  disabled,
  submitting,
  onSubmit,
}: {
  confirmPrompt: {
    question: string;
    options: InteractivePromptOption[];
    recommendedOptionIds?: string[];
    allowOther?: boolean;
  };
  disabled?: boolean;
  submitting?: boolean;
  onSubmit: (answer: InteractivePromptAnswer) => void;
}) {
  return (
    <div className="w-full border border-emerald-200 bg-emerald-50/50">
      <InteractivePromptMenu
        allowOther={false}
        disabled={disabled}
        submitting={submitting}
        onSubmit={onSubmit}
        options={confirmPrompt.options}
        placement="composer"
        question={confirmPrompt.question}
        recommendedOptionIds={confirmPrompt.recommendedOptionIds}
        selectionHint="Choose an option to continue"
        variant="neutral"
      />
    </div>
  );
}

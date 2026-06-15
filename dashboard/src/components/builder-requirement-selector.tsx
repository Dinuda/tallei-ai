"use client";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";

export type RequirementSetupOutput = InteractivePromptAnswer & {
  requirementId: string;
};

export function BuilderRequirementSelector({
  completedOutput,
  onComplete,
  onDismiss,
  question,
  options,
  recommendedOptionIds = [],
  allowMultiple = false,
  allowOther = true,
  requirementId,
  disabled = false,
  placement = "composer",
}: {
  completedOutput?: RequirementSetupOutput | null;
  onComplete?: (output: RequirementSetupOutput) => void;
  onDismiss?: () => void;
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  requirementId: string;
  disabled?: boolean;
  placement?: "transcript" | "composer";
}) {
  return (
    <InteractivePromptMenu
      allowMultiple={allowMultiple}
      allowOther={allowOther}
      disabled={disabled}
      onSubmit={(answer) => onComplete?.({ requirementId, ...answer })}
      onDismiss={onDismiss}
      options={options}
      placement={placement}
      question={question}
      recommendedOptionIds={recommendedOptionIds}
      submittedAnswer={completedOutput ?? undefined}
    />
  );
}

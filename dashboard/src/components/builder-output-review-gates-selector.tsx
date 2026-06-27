"use client";

import { PauseCircle, ShieldCheck } from "lucide-react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";

export type OutputReviewGatesMode = "review_drafts" | "review_drafts_and_send";

export type OutputReviewGatesSelectionOutput = InteractivePromptAnswer & {
  requirementId: string;
  value: { mode: OutputReviewGatesMode };
};

const OPTIONS: Array<{
  id: OutputReviewGatesMode;
  label: string;
  description: string;
  icon: typeof PauseCircle;
}> = [
  {
    id: "review_drafts",
    label: "Pause to review drafts",
    description: "Stop after the draft agent so you can review output before delivery.",
    icon: PauseCircle,
  },
  {
    id: "review_drafts_and_send",
    label: "Pause for drafts and send",
    description: "Review drafts and confirm before any outbound delivery step.",
    icon: ShieldCheck,
  },
];

function modeLabel(mode: OutputReviewGatesMode): string {
  return OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

export function BuilderOutputReviewGatesSelector({
  completedOutput,
  onComplete,
  question = "Should this loop pause for operator review between agents?",
  recommendedOptionIds = ["review_drafts"],
  requirementId,
}: {
  completedOutput?: OutputReviewGatesSelectionOutput | null;
  onComplete?: (output: OutputReviewGatesSelectionOutput) => void;
  question?: string;
  recommendedOptionIds?: string[];
  requirementId: string;
}) {
  const options: InteractivePromptOption[] = OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    value: option.id,
    description: option.description,
  }));

  if (completedOutput) {
    const mode = completedOutput.value?.mode ?? "review_drafts";
    const Icon = OPTIONS.find((option) => option.id === mode)?.icon ?? PauseCircle;
    return (
      <div className="my-3 border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center bg-amber-600 text-white">
            <Icon className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold text-amber-950" style={{ fontFamily: "var(--font-title)" }}>
              Review gates selected
            </div>
            <div className="text-xs text-amber-700">{completedOutput.answerText ?? modeLabel(mode)}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden border border-[#d1d5db] bg-white">
      <InteractivePromptMenu
        allowOther={false}
        onSubmit={(answer) => {
          const selectedId = (answer.selectedOptionIds[0] ?? "review_drafts") as OutputReviewGatesMode;
          const mode = OPTIONS.some((option) => option.id === selectedId) ? selectedId : "review_drafts";
          const label = modeLabel(mode);
          onComplete?.({
            requirementId,
            ...answer,
            value: { mode },
            answerText: label,
          });
        }}
        options={options}
        placement="composer"
        question={question}
        recommendedOptionIds={recommendedOptionIds}
        submittedAnswer={completedOutput ?? undefined}
        variant="amber"
      />
    </div>
  );
}

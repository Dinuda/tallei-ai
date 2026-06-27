"use client";

import { ShieldCheck } from "lucide-react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";

export function BuilderConnectorPrompt({
  question,
  options,
  recommendedOptionIds = [],
  allowMultiple = false,
  allowOther = true,
  disabled = false,
  onDismiss,
  onSubmit,
  selectionHint,
  step,
}: {
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  disabled?: boolean;
  onDismiss?: () => void;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  selectionHint?: string;
  step?: { index: number; total: number };
}) {
  const connectedCount = recommendedOptionIds.filter((id) =>
    options.some((option) => option.id === id),
  ).length;

  return (
    <div className="w-full border border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg)]">
      <div className="border-b border-[var(--builder-indigo-border-light)] bg-white px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--builder-indigo-bg-solid)] text-[var(--builder-indigo-accent)]">
              <ShieldCheck className="size-4" />
            </span>
            <div>
              <div
                className="text-[14px] font-bold tracking-[-0.02em] text-[var(--builder-indigo-text)]"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Choose an app
              </div>
              <p className="mt-0.5 text-[13px] text-[var(--builder-indigo-text-muted)]">
                Pick the app that should power this loop.
              </p>
            </div>
          </div>
          {options.length > 0 ? (
            <span className="border border-[var(--builder-indigo-border)] bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--builder-indigo-accent)]">
              {connectedCount} of {options.length} recommended
            </span>
          ) : null}
        </div>
      </div>
      <InteractivePromptMenu
        allowMultiple={allowMultiple}
        allowOther={allowOther}
        disabled={disabled}
        onDismiss={onDismiss}
        onSubmit={onSubmit}
        options={options}
        placement="composer"
        question={question}
        rankedAppsLayout
        recommendedOptionIds={recommendedOptionIds}
        selectionHint={selectionHint}
        step={step}
        variant="connector"
      />
    </div>
  );
}

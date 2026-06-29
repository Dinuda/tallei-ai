"use client";

import { ClipboardCheck } from "lucide-react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import type { OutcomeBrief } from "@/components/conductor/conductor-shared";
import { plainLanguageBriefSummary } from "@/components/conductor/conductor-shared";

export function BuilderOutcomeBriefPrompt({
  brief,
  confirmPrompt,
  disabled,
  onSubmit,
}: {
  brief: OutcomeBrief;
  confirmPrompt: {
    question: string;
    options: InteractivePromptOption[];
    recommendedOptionIds?: string[];
    allowOther?: boolean;
  };
  disabled?: boolean;
  onSubmit: (answer: InteractivePromptAnswer) => void;
}) {
  const summary = plainLanguageBriefSummary(brief);

  return (
    <div className="w-full border border-emerald-200 bg-emerald-50/50">
      <div className="border-b border-emerald-200 bg-white px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-emerald-50 text-emerald-700">
            <ClipboardCheck className="size-4" />
          </span>
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Review your automation</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">{brief.outcome}</p>
            </div>
            <dl className="space-y-2.5 text-sm text-slate-700">
              <div>
                <dt className="font-semibold text-slate-900">When it runs</dt>
                <dd className="mt-0.5">{summary.whenItRuns}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-900">What it does</dt>
                <dd className="mt-0.5">
                  <ul className="list-inside list-disc space-y-0.5">
                    {summary.steps.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-900">Before anything is sent</dt>
                <dd className="mt-0.5">{summary.beforeSending}</dd>
              </div>
            </dl>
            {brief.userSummary?.assumptionsNote ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span className="font-semibold">Note: </span>
                {brief.userSummary.assumptionsNote}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <InteractivePromptMenu
        allowOther={confirmPrompt.allowOther ?? true}
        disabled={disabled}
        onSubmit={onSubmit}
        options={confirmPrompt.options}
        placement="composer"
        question={confirmPrompt.question}
        recommendedOptionIds={confirmPrompt.recommendedOptionIds}
        selectionHint="Choose an option, then press Continue"
        variant="neutral"
      />
    </div>
  );
}

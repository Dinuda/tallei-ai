"use client";

import { Check, ChevronLeft, ChevronRight, Circle, CornerDownLeft, Pencil, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type InteractivePromptOption = {
  id: string;
  label: string;
  value: string;
  description?: string;
  icon?: string;
  outcomeId?: string;
  role?: string;
};

export type InteractivePromptAnswer = {
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
  answerText: string;
};

function ProviderLogo({
  icon,
  label,
  selected,
  index,
}: {
  icon?: string;
  label: string;
  selected: boolean;
  index: number;
}) {
  const src = icon ? `https://logos.composio.dev/api/${icon}` : undefined;

  if (!src) {
    return (
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
          selected
            ? "border-[#111827] bg-[#111827] text-white"
            : "border-[#e5e7eb] bg-white text-[#6b7280]"
        )}
      >
        {selected ? <Check className="size-3" /> : index + 1}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border",
        selected
          ? "border-[#111827] bg-[#111827]"
          : "border-[#e5e7eb] bg-white"
      )}
    >
      {selected ? (
        <Check className="size-4 text-white" />
      ) : (
        <img alt={label} className="size-5 object-contain" draggable={false} src={src} />
      )}
    </span>
  );
}

export function InteractivePromptMenu({
  question,
  options,
  recommendedOptionIds = [],
  allowMultiple = false,
  allowOther = true,
  disabled = false,
  submittedAnswer,
  placement = "transcript",
  step,
  selectionHint,
  rankedAppsLayout = false,
  topAppCount = 5,
  onSubmit,
  onDismiss,
}: {
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  disabled?: boolean;
  submittedAnswer?: InteractivePromptAnswer;
  placement?: "transcript" | "composer";
  step?: { index: number; total: number };
  selectionHint?: string;
  /** Top N recommended apps + searchable "More apps" section. */
  rankedAppsLayout?: boolean;
  topAppCount?: number;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  onDismiss?: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    submittedAnswer?.selectedOptionIds ?? []
  );
  const [otherText, setOtherText] = useState(submittedAnswer?.otherText ?? "");
  const [appSearch, setAppSearch] = useState("");
  const recommended = useMemo(
    () => new Set(recommendedOptionIds),
    [recommendedOptionIds]
  );
  const isSubmitted = Boolean(submittedAnswer);

  const hasOutcomeGroups = useMemo(
    () => options.some((option) => Boolean(option.outcomeId)),
    [options]
  );

  const { topOptions, moreOptions, rankedDisplayOptions } = useMemo(() => {
    if (!rankedAppsLayout) {
      return {
        topOptions: options,
        moreOptions: [] as InteractivePromptOption[],
        rankedDisplayOptions: options,
      };
    }

    const topIds = recommendedOptionIds.slice(0, topAppCount);
    const top = topIds
      .map((id) => options.find((option) => option.id === id))
      .filter((option): option is InteractivePromptOption => Boolean(option));

    const resolvedTop = top.length > 0 ? top : options.slice(0, topAppCount);
    const topIdSet = new Set(resolvedTop.map((option) => option.id));
    const rest = options.filter((option) => !topIdSet.has(option.id));

    const query = appSearch.trim().toLowerCase();
    const filterOptions = (rows: InteractivePromptOption[]) => {
      if (!query) return rows;
      return rows.filter((option) => {
        const haystack = `${option.label} ${option.value} ${option.description ?? ""}`.toLowerCase();
        return haystack.includes(query);
      });
    };

    const filteredTop = filterOptions(resolvedTop);
    const filteredMore = filterOptions(rest);
    const searching = query.length > 0;

    return {
      topOptions: resolvedTop,
      moreOptions: rest,
      rankedDisplayOptions: searching
        ? filterOptions(options)
        : [...filteredTop, ...filteredMore],
    };
  }, [options, rankedAppsLayout, recommendedOptionIds, topAppCount, appSearch]);

  const isSearching = rankedAppsLayout && appSearch.trim().length > 0;
  const showRankedMoreLabel = rankedAppsLayout && !isSearching && moreOptions.length > 0;

  function renderOption(option: InteractivePromptOption, index: number) {
    const selected = selectedIds.includes(option.id);
    return (
      <button
        className={cn(
          "flex w-full items-start gap-3 border border-transparent px-3 py-2.5 text-left transition-colors",
          selected ? "border-[#d1d5db] bg-[#fafafa] text-[#111827]" : "hover:bg-[#fafafa]",
          (disabled || isSubmitted) && "cursor-default"
        )}
        disabled={disabled || isSubmitted}
        key={option.id ?? `option-${index}`}
        onClick={() => toggle(option.id)}
        type="button"
      >
        <ProviderLogo
          icon={option.icon}
          index={index}
          label={option.label}
          selected={selected}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
            <span>{option.label}</span>
            {recommended.has(option.id) && (
              <span className="border border-[#e5e7eb] bg-[#fafafa] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">
                Recommended
              </span>
            )}
          </span>
          {option.description && (
            <span className="mt-0.5 block text-xs text-[#6b7280]">
              {option.description}
            </span>
          )}
        </span>
        <Circle
          className={cn(
            "mt-2 size-2 text-[#d1d5db]",
            selected && "fill-[#111827] text-[#111827]"
          )}
        />
      </button>
    );
  }

  useEffect(() => {
    if (!onDismiss || isSubmitted || disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss, isSubmitted, disabled]);

  function toggle(optionId: string) {
    if (disabled || isSubmitted) return;
    const option = options.find((row) => row.id === optionId);
    setSelectedIds((current) => {
      if (allowMultiple && option?.outcomeId) {
        const withoutSameOutcome = current.filter((id) => {
          const row = options.find((opt) => opt.id === id);
          return row?.outcomeId !== option.outcomeId;
        });
        return current.includes(optionId)
          ? withoutSameOutcome
          : [...withoutSameOutcome, optionId];
      }
      return allowMultiple
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : [optionId];
    });
  }

  function submit() {
    const selectedOptions = options.filter((option) =>
      selectedIds.includes(option.id)
    );
    const custom = otherText.trim();
    const answerText = [
      ...selectedOptions.map((option) => option.value),
      ...(custom ? [custom] : []),
    ].join("; ");
    if (!answerText) return;
    onSubmit({
      selectedOptionIds: selectedOptions.map((option) => option.id),
      selectedValues: selectedOptions.map((option) => option.value),
      ...(custom ? { otherText: custom } : {}),
      answerText,
    });
  }

  return (
    <div
      className={cn(
        "w-full overflow-hidden bg-white",
        placement === "composer"
          ? "border-0 shadow-none"
          : "my-3 border border-[#d1d5db] shadow-sm"
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
        <div className="min-w-0 flex-1 text-sm font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
          {question}
        </div>
        {step ? (
          <div className="flex shrink-0 items-center gap-1 text-xs text-[#6b7280]">
            <ChevronLeft className="size-3.5 opacity-40" />
            <span>{step.index} of {step.total}</span>
            <ChevronRight className="size-3.5 opacity-40" />
          </div>
        ) : null}
      </div>
      {rankedAppsLayout ? (
        <div className="border-b border-[#e5e7eb] px-3 py-2">
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-[#9ca3af]" />
            <Input
              className="h-9 border-[#e5e7eb] bg-[#fafafa] text-sm shadow-none placeholder:text-[#9ca3af] focus-visible:ring-1 focus-visible:ring-[#d1d5db]"
              disabled={disabled || isSubmitted}
              onChange={(event) => setAppSearch(event.target.value)}
              placeholder="Search apps…"
              value={appSearch}
            />
          </div>
        </div>
      ) : null}
      <div className="p-2">
        {rankedAppsLayout ? (
          <div className="max-h-[21rem] space-y-1 overflow-y-auto">
            {rankedDisplayOptions.length > 0 ? (
              rankedDisplayOptions.map((option, index) => {
                const showMoreDivider =
                  showRankedMoreLabel
                  && index === topOptions.length
                  && index > 0;
                return (
                  <div key={option.id ?? `option-${index}`}>
                    {showMoreDivider ? (
                      <p className="sticky top-0 z-10 bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[#9ca3af]">
                        More apps
                      </p>
                    ) : null}
                    {renderOption(option, index)}
                  </div>
                );
              })
            ) : (
              <p className="px-3 py-2 text-xs text-[#9ca3af]">No apps match your search.</p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {options.map((option, index) => renderOption(option, index))}
          </div>
        )}
      </div>
      {allowOther && !isSubmitted && (
        <div className="mx-3 mt-2 border-t border-[#e5e7eb] pt-3">
          <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-[#9ca3af]">
            Or describe it yourself
          </p>
          <div className="flex items-center gap-2">
            <Pencil className="size-4 shrink-0 text-[#6b7280]" />
            <Input
              className="border-0 px-0 text-[#111827] shadow-none placeholder:text-[#9ca3af] focus-visible:ring-0"
              disabled={disabled}
              onChange={(event) => setOtherText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder="Tell Tallei what to do differently"
              value={otherText}
            />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-[#e5e7eb] bg-[#fafafa] px-3 py-3">
        <div className="flex items-center gap-2">
          {placement === "composer" && onDismiss && !isSubmitted && (
            <Button
              className="h-7 gap-1.5 px-2 text-xs text-[#6b7280] hover:bg-white hover:text-[#111827]"
              disabled={disabled}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              Dismiss <span className="text-[#9ca3af]">ESC</span>
            </Button>
          )}
          <span className="text-xs text-[#6b7280]">
            {isSubmitted
              ? `Answered: ${submittedAnswer?.answerText}`
              : selectionHint
                ?? (rankedAppsLayout
                  ? "Search or scroll to find an app"
                  : allowMultiple && hasOutcomeGroups
                  ? "Pick one connector per part of the loop, or describe your own approach below"
                  : allowMultiple
                    ? "Select one or more options, or describe your own approach below"
                    : recommendedOptionIds.length > 0
                      ? "Pick a recommended app above, or browse more apps below"
                      : "Pick an option, or describe your own approach below")}
          </span>
        </div>
        {!isSubmitted && (
          <Button
            className="bg-[#111827] text-white hover:bg-[#374151]"
            disabled={
              disabled ||
              (selectedIds.length === 0 && !otherText.trim())
            }
            onClick={submit}
            size="sm"
            type="button"
            style={{ borderRadius: 0 }}
          >
            {placement === "composer" ? "Continue" : "Submit"} <CornerDownLeft className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

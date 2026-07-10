"use client";

import { Check, ChevronLeft, ChevronRight, Circle, CornerDownLeft, Pencil, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
  disabled?: boolean;
};

export type InteractivePromptAnswer = {
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
  answerText: string;
};

export type InteractivePromptVariant = "neutral" | "connector" | "violet" | "amber";

type PromptTheme = {
  outerBorder: string;
  headerBg: string;
  headerBorder: string;
  title: string;
  step: string;
  searchBorder: string;
  searchBg: string;
  optionSelected: string;
  optionHover: string;
  optionTitle: string;
  optionDesc: string;
  recommended: string;
  divider: string;
  footerBg: string;
  footerBorder: string;
  hint: string;
  primaryBtn: string;
  selectedDot: string;
  logoSelected: string;
  logoDefault: string;
};

/** Primary options stay visible; additional options scroll below. */
const MAX_PRIMARY_OPTIONS = 4;

const PROMPT_THEMES: Record<InteractivePromptVariant, PromptTheme> = {
  neutral: {
    outerBorder: "border-[var(--ed-border)]",
    headerBg: "bg-[var(--ed-surface-alt)]",
    headerBorder: "border-[var(--ed-border-light)]",
    title: "text-[var(--ed-text)]",
    step: "text-[var(--ed-text-3)]",
    searchBorder: "border-[var(--ed-border-light)]",
    searchBg: "bg-[var(--ed-surface-alt)]",
    optionSelected: "border-[var(--ed-border)] bg-[var(--ed-surface-alt)] text-[var(--ed-text)]",
    optionHover: "hover:bg-[var(--ed-surface-alt)]",
    optionTitle: "text-[var(--ed-text)]",
    optionDesc: "text-[var(--ed-text-3)]",
    recommended: "border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] text-[var(--ed-text-3)]",
    divider: "text-[var(--ed-text-4)]",
    footerBg: "bg-[var(--ed-surface-alt)]",
    footerBorder: "border-[var(--ed-border-light)]",
    hint: "text-[var(--ed-text-3)]",
    primaryBtn: "bg-[var(--ed-text)] hover:bg-[var(--ed-text-2)]",
    selectedDot: "fill-[var(--ed-text)] text-[var(--ed-text)]",
    logoSelected: "border-[var(--ed-text)] bg-[var(--ed-text)]",
    logoDefault: "border-[var(--ed-border-light)] bg-white",
  },
  connector: {
    outerBorder: "border-[var(--builder-indigo-border)]",
    headerBg: "bg-white",
    headerBorder: "border-[var(--builder-indigo-border-light)]",
    title: "text-[var(--builder-indigo-text)]",
    step: "text-[var(--builder-indigo-text-muted)]",
    searchBorder: "border-[var(--builder-indigo-border-light)]",
    searchBg: "bg-[var(--builder-indigo-bg-solid)]",
    optionSelected: "border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg-solid)] text-[var(--builder-indigo-text)]",
    optionHover: "hover:bg-[var(--builder-indigo-bg-solid)]",
    optionTitle: "text-[var(--builder-indigo-text)]",
    optionDesc: "text-[var(--builder-indigo-text-muted)]",
    recommended: "border-[var(--builder-indigo-border)] bg-white text-[var(--builder-indigo-accent)]",
    divider: "text-[var(--builder-indigo-text-muted)]",
    footerBg: "bg-[var(--builder-indigo-bg-solid)]",
    footerBorder: "border-[var(--builder-indigo-border-light)]",
    hint: "text-[var(--builder-indigo-text-muted)]",
    primaryBtn: "bg-[var(--builder-indigo-accent)] hover:bg-[var(--builder-indigo-accent-hover)]",
    selectedDot: "fill-[var(--builder-indigo-accent)] text-[var(--builder-indigo-accent)]",
    logoSelected: "border-[var(--builder-indigo-accent)] bg-[var(--builder-indigo-accent)]",
    logoDefault: "border-[var(--builder-indigo-border-light)] bg-white",
  },
  violet: {
    outerBorder: "border-[var(--builder-violet-border)]",
    headerBg: "bg-white",
    headerBorder: "border-[var(--builder-violet-border-light)]",
    title: "text-[var(--builder-violet-text)]",
    step: "text-[var(--builder-violet-text-muted)]",
    searchBorder: "border-[var(--builder-violet-border-light)]",
    searchBg: "bg-violet-50",
    optionSelected: "border-[var(--builder-violet-border)] bg-violet-50 text-[var(--builder-violet-text)]",
    optionHover: "hover:bg-violet-50",
    optionTitle: "text-[var(--builder-violet-text)]",
    optionDesc: "text-[var(--builder-violet-text-muted)]",
    recommended: "border-[var(--builder-violet-border)] bg-white text-[var(--builder-violet-accent)]",
    divider: "text-[var(--builder-violet-text-muted)]",
    footerBg: "bg-violet-50",
    footerBorder: "border-[var(--builder-violet-border-light)]",
    hint: "text-[var(--builder-violet-text-muted)]",
    primaryBtn: "bg-[var(--builder-violet-accent)] hover:bg-[var(--builder-violet-accent-hover)]",
    selectedDot: "fill-[var(--builder-violet-accent)] text-[var(--builder-violet-accent)]",
    logoSelected: "border-[var(--builder-violet-accent)] bg-[var(--builder-violet-accent)]",
    logoDefault: "border-[var(--builder-violet-border-light)] bg-white",
  },
  amber: {
    outerBorder: "border-[var(--builder-amber-border)]",
    headerBg: "bg-white",
    headerBorder: "border-[var(--builder-amber-border)]",
    title: "text-[var(--builder-amber-text)]",
    step: "text-amber-700",
    searchBorder: "border-[var(--builder-amber-border)]",
    searchBg: "bg-[var(--builder-amber-bg)]",
    optionSelected: "border-[var(--builder-amber-border)] bg-[var(--builder-amber-bg)] text-[var(--builder-amber-text)]",
    optionHover: "hover:bg-[var(--builder-amber-bg)]",
    optionTitle: "text-[var(--builder-amber-text)]",
    optionDesc: "text-amber-700",
    recommended: "border-[var(--builder-amber-border)] bg-white text-[var(--builder-amber-accent)]",
    divider: "text-amber-600",
    footerBg: "bg-[var(--builder-amber-bg)]",
    footerBorder: "border-[var(--builder-amber-border)]",
    hint: "text-amber-700",
    primaryBtn: "bg-[var(--builder-amber-accent)] hover:bg-amber-700",
    selectedDot: "fill-[var(--builder-amber-accent)] text-[var(--builder-amber-accent)]",
    logoSelected: "border-[var(--builder-amber-accent)] bg-[var(--builder-amber-accent)]",
    logoDefault: "border-[var(--builder-amber-border)] bg-white",
  },
};

function ProviderLogo({
  icon,
  label,
  selected,
  index,
  theme,
  useConnectorLogos,
}: {
  icon?: string;
  label: string;
  selected: boolean;
  index: number;
  theme: PromptTheme;
  useConnectorLogos: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = useConnectorLogos && icon && !imageFailed
    ? `https://logos.composio.dev/api/${icon}`
    : undefined;

  if (!src) {
    return (
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
          selected
            ? cn(theme.logoSelected, "text-white")
            : cn(theme.logoDefault, "text-[var(--ed-text-3)]")
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
        selected ? theme.logoSelected : theme.logoDefault
      )}
    >
      {selected ? (
        <Check className="size-4 text-white" />
      ) : (
        <img
          alt={label}
          className="size-5 object-contain"
          draggable={false}
          onError={() => setImageFailed(true)}
          src={src}
        />
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
  submitting = false,
  submittedAnswer,
  placement = "transcript",
  step,
  selectionHint,
  rankedAppsLayout = false,
  topAppCount = 5,
  variant = "neutral",
  onSubmit,
  onDismiss,
}: {
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  disabled?: boolean;
  /** Parent is posting the answer to the server (tool-answer stream in flight). */
  submitting?: boolean;
  submittedAnswer?: InteractivePromptAnswer;
  placement?: "transcript" | "composer";
  step?: { index: number; total: number };
  selectionHint?: string;
  /** Top N recommended apps + searchable "More apps" section. */
  rankedAppsLayout?: boolean;
  topAppCount?: number;
  variant?: InteractivePromptVariant;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  onDismiss?: () => void;
}) {
  const theme = PROMPT_THEMES[variant];
  const useConnectorLogos = variant === "connector" || rankedAppsLayout;
  const visibleOptions = useMemo(
    () => options.filter((option) => option.label.trim().length > 0),
    [options],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (submittedAnswer?.selectedOptionIds?.length) return submittedAnswer.selectedOptionIds;
    if (!allowMultiple && recommendedOptionIds.length === 1) {
      const recommendedId = recommendedOptionIds[0];
      if (visibleOptions.some((option) => option.id === recommendedId)) return [recommendedId];
    }
    return [];
  });
  const [otherText, setOtherText] = useState(submittedAnswer?.otherText ?? "");
  const [appSearch, setAppSearch] = useState("");
  const recommended = useMemo(
    () => new Set(recommendedOptionIds),
    [recommendedOptionIds]
  );
  const [submittedLocally, setSubmittedLocally] = useState(false);
  const [lastLocalAnswerText, setLastLocalAnswerText] = useState<string | null>(null);
  const isSubmitted = Boolean(submittedAnswer) || submittedLocally;
  const autoSubmitSingleChoice = !allowMultiple && !allowOther;
  // Content fingerprint — parent often passes a fresh `options` array reference
  // with the same rows; depend on identity of the question + option ids only.
  const optionsRevision = useMemo(
    () => `${question}\0${visibleOptions.map((option) => option.id).join("\0")}`,
    [question, visibleOptions],
  );

  useEffect(() => {
    setSubmittedLocally(false);
    setLastLocalAnswerText(null);
    setOtherText(submittedAnswer?.otherText ?? "");
    setAppSearch("");
    if (submittedAnswer?.selectedOptionIds?.length) {
      setSelectedIds(submittedAnswer.selectedOptionIds);
      return;
    }
    if (!allowMultiple && recommendedOptionIds.length === 1) {
      const recommendedId = recommendedOptionIds[0];
      if (visibleOptions.some((option) => option.id === recommendedId)) {
        setSelectedIds([recommendedId]);
        return;
      }
    }
    setSelectedIds([]);
  }, [optionsRevision]);

  const prevSubmittingRef = useRef(submitting);
  useEffect(() => {
    const wasSubmitting = prevSubmittingRef.current;
    prevSubmittingRef.current = submitting;
    if (wasSubmitting && !submitting && submittedLocally && !submittedAnswer) {
      setSubmittedLocally(false);
      setLastLocalAnswerText(null);
    }
  }, [submitting, submittedLocally, submittedAnswer]);

  const hasOutcomeGroups = useMemo(
    () => visibleOptions.some((option) => Boolean(option.outcomeId)),
    [visibleOptions],
  );

  const { topOptions, moreOptions, rankedDisplayOptions } = useMemo(() => {
    if (!rankedAppsLayout) {
      return {
        topOptions: visibleOptions,
        moreOptions: [] as InteractivePromptOption[],
        rankedDisplayOptions: visibleOptions,
      };
    }

    const topIds = recommendedOptionIds.slice(0, topAppCount);
    const top = topIds
      .map((id) => visibleOptions.find((option) => option.id === id))
      .filter((option): option is InteractivePromptOption => Boolean(option));

    const resolvedTop = top.length > 0 ? top : visibleOptions.slice(0, topAppCount);
    const topIdSet = new Set(resolvedTop.map((option) => option.id));
    const rest = visibleOptions.filter((option) => !topIdSet.has(option.id));

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
        ? filterOptions(visibleOptions)
        : [...filteredTop, ...filteredMore],
    };
  }, [visibleOptions, rankedAppsLayout, recommendedOptionIds, topAppCount, appSearch]);

  const isSearching = rankedAppsLayout && appSearch.trim().length > 0;
  const showRankedMoreLabel = rankedAppsLayout && !isSearching && moreOptions.length > 0;

  const { primaryOptions, overflowOptions } = useMemo(() => {
    if (rankedAppsLayout || visibleOptions.length <= MAX_PRIMARY_OPTIONS) {
      return {
        primaryOptions: visibleOptions,
        overflowOptions: [] as InteractivePromptOption[],
      };
    }
    return {
      primaryOptions: visibleOptions.slice(0, MAX_PRIMARY_OPTIONS),
      overflowOptions: visibleOptions.slice(MAX_PRIMARY_OPTIONS),
    };
  }, [visibleOptions, rankedAppsLayout]);

  function renderOption(option: InteractivePromptOption, index: number) {
    const selected = selectedIds.includes(option.id);
    return (
      <button
        className={cn(
          "flex w-full items-start gap-3 border border-transparent px-3 py-2.5 text-left transition-colors",
          selected ? theme.optionSelected : theme.optionHover,
          (disabled || isSubmitted || submitting) && "cursor-default",
          option.disabled && "cursor-not-allowed opacity-50",
        )}
        disabled={disabled || isSubmitted || submitting || option.disabled}
        key={option.id ?? `option-${index}`}
        onClick={() => toggle(option.id)}
        type="button"
      >
        <ProviderLogo
          icon={option.icon}
          index={index}
          label={option.label}
          selected={selected}
          theme={theme}
          useConnectorLogos={useConnectorLogos}
        />
        <span className="min-w-0 flex-1">
          <span className={cn("flex flex-wrap items-center gap-2 text-sm font-semibold", theme.optionTitle)} style={{ fontFamily: "var(--font-title)" }}>
            <span>{option.label}</span>
            {recommended.has(option.id) && (
              <span className={cn("border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", theme.recommended)}>
                Recommended
              </span>
            )}
          </span>
          {option.description && (
            <span className={cn("mt-0.5 block text-xs", theme.optionDesc)}>
              {option.description}
            </span>
          )}
        </span>
        <Circle
          className={cn(
            "mt-2 size-2 text-[var(--ed-border)]",
            selected && theme.selectedDot
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

  function submitWithSelectedIds(nextSelectedIds: string[], customText = otherText) {
    const selectedOptions = visibleOptions.filter((option) =>
      nextSelectedIds.includes(option.id),
    );
    const custom = customText.trim();
    const answerText = [
      ...selectedOptions.map((option) => option.label),
      ...(custom ? [custom] : []),
    ].join("; ");
    if (!answerText) return;
    setSelectedIds(nextSelectedIds);
    setSubmittedLocally(true);
    setLastLocalAnswerText(answerText);
    onSubmit({
      selectedOptionIds: selectedOptions.map((option) => option.id),
      selectedValues: selectedOptions.map((option) => option.value),
      ...(custom ? { otherText: custom } : {}),
      answerText,
    });
  }

  function toggle(optionId: string) {
    if (disabled || isSubmitted || submitting) return;
    const option = visibleOptions.find((row) => row.id === optionId);
    if (option?.disabled) return;
    let nextSelectedIds: string[];
    if (allowMultiple && option?.outcomeId) {
      const withoutSameOutcome = selectedIds.filter((id) => {
        const row = visibleOptions.find((opt) => opt.id === id);
        return row?.outcomeId !== option.outcomeId;
      });
      nextSelectedIds = selectedIds.includes(optionId)
        ? withoutSameOutcome
        : [...withoutSameOutcome, optionId];
    } else if (allowMultiple) {
      nextSelectedIds = selectedIds.includes(optionId)
        ? selectedIds.filter((id) => id !== optionId)
        : [...selectedIds, optionId];
    } else {
      nextSelectedIds = [optionId];
    }
    if (autoSubmitSingleChoice) {
      submitWithSelectedIds(nextSelectedIds);
      return;
    }
    setSelectedIds(nextSelectedIds);
  }

  function submit() {
    submitWithSelectedIds(selectedIds);
  }

  return (
    <div
      className={cn(
        "w-full overflow-hidden bg-white",
        placement === "composer"
          ? "border-0 shadow-none"
          : cn("my-3 border shadow-sm", theme.outerBorder)
      )}
    >
      <div className={cn("flex items-center justify-between gap-3 border-b px-4 py-3", theme.headerBorder, theme.headerBg)}>
        <div className={cn("min-w-0 flex-1 text-sm font-semibold", theme.title)} style={{ fontFamily: "var(--font-title)" }}>
          {question}
        </div>
        {step ? (
          <div className={cn("flex shrink-0 items-center gap-1 text-xs", theme.step)}>
            <ChevronLeft className="size-3.5 opacity-40" />
            <span>{step.index} of {step.total}</span>
            <ChevronRight className="size-3.5 opacity-40" />
          </div>
        ) : null}
      </div>
      {rankedAppsLayout ? (
        <div className={cn("border-b px-3 py-2", theme.headerBorder)}>
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-[var(--ed-text-4)]" />
            <Input
              className={cn("h-9 text-sm shadow-none placeholder:text-[var(--ed-text-4)] focus-visible:ring-1", theme.searchBorder, theme.searchBg)}
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
                      <p className={cn("sticky top-0 z-10 bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-wide", theme.divider)}>
                        More apps
                      </p>
                    ) : null}
                    {renderOption(option, index)}
                  </div>
                );
              })
            ) : (
              <p className={cn("px-3 py-2 text-xs", theme.divider)}>No apps match your search.</p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {primaryOptions.map((option, index) => renderOption(option, index))}
            {overflowOptions.length > 0 ? (
              <>
                <p className={cn("sticky top-0 z-10 bg-white px-3 py-2 text-[11px] font-medium uppercase tracking-wide", theme.divider)}>
                  More options
                </p>
                <div className="max-h-[11rem] space-y-1 overflow-y-auto">
                  {overflowOptions.map((option, index) =>
                    renderOption(option, index + primaryOptions.length)
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
      {allowOther && !isSubmitted && (
        <div className={cn("mx-3 mt-2 border-t pt-3", theme.footerBorder)}>
          <p className={cn("mb-2 px-1 text-[11px] font-medium uppercase tracking-wide", theme.divider)}>
            Or describe it yourself
          </p>
          <div className="flex items-center gap-2">
            <Pencil className={cn("size-4 shrink-0", theme.hint)} />
            <Input
              className={cn("border-0 px-0 shadow-none focus-visible:ring-0", theme.title, "placeholder:text-[var(--ed-text-4)]")}
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
      <div className={cn("flex items-center justify-between gap-3 border-t px-3 py-3", theme.footerBorder, theme.footerBg)}>
        <div className="flex items-center gap-2">
          {placement === "composer" && onDismiss && !isSubmitted && (
            <Button
              className={cn("h-7 gap-1.5 px-2 text-xs hover:bg-white", theme.hint, "hover:text-[var(--ed-text)]")}
              disabled={disabled}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              Dismiss <span className="text-[var(--ed-text-4)]">ESC</span>
            </Button>
          )}
          <span className={cn("text-xs", theme.hint)}>
            {submitting && !isSubmitted
              ? "Sending answer…"
              : isSubmitted
              ? `Answered: ${submittedAnswer?.answerText?.trim() || lastLocalAnswerText?.trim() || otherText.trim() || "saved"}`
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
        {!isSubmitted && !autoSubmitSingleChoice && (
          <Button
            className={cn("text-white", theme.primaryBtn)}
            disabled={
              disabled ||
              submitting ||
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

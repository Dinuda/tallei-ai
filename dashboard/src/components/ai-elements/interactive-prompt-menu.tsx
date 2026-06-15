"use client";

import { Check, Circle, CornerDownLeft, Pencil, X } from "lucide-react";
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
  onSubmit: (answer: InteractivePromptAnswer) => void;
  onDismiss?: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    submittedAnswer?.selectedOptionIds ?? []
  );
  const [otherText, setOtherText] = useState(submittedAnswer?.otherText ?? "");
  const recommended = useMemo(
    () => new Set(recommendedOptionIds),
    [recommendedOptionIds]
  );
  const isSubmitted = Boolean(submittedAnswer);

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
    setSelectedIds((current) =>
      allowMultiple
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : [optionId]
    );
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
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3 text-sm font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
        {question}
      </div>
      <div className="space-y-1 p-2">
        {options.map((option, index) => {
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
        })}
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
              : allowMultiple
                ? "Select one or more options, or describe your own approach below"
                : "Pick an option, or describe your own approach below"}
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
            Submit <CornerDownLeft className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

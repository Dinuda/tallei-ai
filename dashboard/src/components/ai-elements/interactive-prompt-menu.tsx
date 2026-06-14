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
  const src = icon
    ? `https://logos.composio.dev/api/${icon}`
    : undefined;

  if (!src) {
    return (
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
          selected
            ? "border-[#4338ca] bg-[#4338ca] text-white"
            : "border-[#e8e5f0] bg-white text-[#8a86a0]"
        )}
      >
        {selected ? <Check className="size-3" /> : index + 1}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border overflow-hidden",
        selected
          ? "border-[#4338ca] bg-[#4338ca]"
          : "border-[#e8e5f0] bg-white"
      )}
    >
      {selected ? (
        <Check className="size-4 text-white" />
      ) : (
        <img
          alt={label}
          className="size-5 object-contain"
          draggable={false}
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
        "w-full overflow-hidden bg-[#f9f8fc]",
        placement === "composer"
          ? "rounded-none border-0 shadow-none"
          : "my-3 rounded-xl border border-[#e8e5f0] shadow-sm"
      )}
    >
      <div className="px-4 pb-2 pt-4 text-sm font-medium">{question}</div>
      <div className="space-y-1 px-2">
        {options.map((option, index) => {
          const selected = selectedIds.includes(option.id);
          return (
            <button
              className={cn(
                "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                selected ? "bg-[#f0edff] text-foreground" : "hover:bg-[#f5f3ff]",
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
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{option.label}</span>
                  {recommended.has(option.id) && (
                    <span className="rounded-full border border-[#e8e5f0] bg-white px-2 py-0.5 text-[10px] font-medium text-[#8a86a0]">
                      Recommended
                    </span>
                  )}
                </span>
                {option.description && (
                  <span className="mt-0.5 block text-xs text-[#8a86a0]">
                    {option.description}
                  </span>
                )}
              </span>
              <Circle
                className={cn(
                  "mt-2 size-2 text-[#d1cfd8]",
                  selected && "fill-[#4338ca] text-[#4338ca]"
                )}
              />
            </button>
          );
        })}
      </div>
      {allowOther && !isSubmitted && (
        <div className="mx-3 mt-2 flex items-center gap-2 border-t pt-3">
          <Pencil className="size-4 shrink-0 text-muted-foreground" />
          <Input
            className="border-0 px-0 shadow-none focus-visible:ring-0"
            disabled={disabled}
            onChange={(event) => setOtherText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="No, and tell Tallei what to do differently"
            value={otherText}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 px-3 py-3">
        <div className="flex items-center gap-2">
          {placement === "composer" && onDismiss && !isSubmitted && (
            <Button
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={disabled}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              Dismiss <span className="text-muted-foreground">ESC</span>
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {isSubmitted
              ? `Answered: ${submittedAnswer?.answerText}`
              : allowMultiple
                ? "Select one or more options"
                : ""}
          </span>
        </div>
        {!isSubmitted && (
          <Button
            disabled={
              disabled ||
              (selectedIds.length === 0 && !otherText.trim())
            }
            onClick={submit}
            size="sm"
            type="button"
          >
            Submit <CornerDownLeft className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

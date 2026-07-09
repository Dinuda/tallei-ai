"use client";

import type { ReasoningUIPart } from "ai";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  useReasoning,
} from "@/components/ai-elements/reasoning";
import { sanitizeConductorReasoningForDisplay } from "@/lib/conductor-reasoning-sanitize";

const REASONING_TRUNCATE_AT = 2_000;

function LazyReasoningBody({
  displayText,
  isStreaming,
  truncated,
  showFullThought,
  onToggleFullThought,
}: {
  displayText: string;
  isStreaming: boolean;
  truncated: boolean;
  showFullThought: boolean;
  onToggleFullThought: () => void;
}) {
  const { isOpen } = useReasoning();
  if (!isStreaming && !isOpen) {
    return null;
  }

  const visibleText = truncated && !showFullThought
    ? `${displayText.slice(0, REASONING_TRUNCATE_AT).trimEnd()}…`
    : displayText;

  return (
    <ReasoningContent
      className="conductor-reasoning-collapsible"
      footer={truncated ? (
        <button
          className="mt-2 text-xs font-medium text-[var(--ed-text-2)] underline-offset-2 hover:underline"
          onClick={onToggleFullThought}
          type="button"
        >
          {showFullThought ? "Show less" : "Show full thought"}
        </button>
      ) : undefined}
      isStreaming={isStreaming}
    >
      {visibleText}
    </ReasoningContent>
  );
}

export const ConductorReasoningPart = memo(function ConductorReasoningPart({
  part,
  expandByDefault = false,
  pauseForUserInput = false,
}: {
  part: ReasoningUIPart;
  expandByDefault?: boolean;
  pauseForUserInput?: boolean;
}) {
  const isStreaming = part.state === "streaming";
  const displayStreaming = isStreaming && !pauseForUserInput;
  const [isOpen, setIsOpen] = useState(displayStreaming && expandByDefault);
  const [showFullThought, setShowFullThought] = useState(false);
  const userToggledRef = useRef(false);
  const rawText = part.text ?? "";
  const displayText = useMemo(
    () => sanitizeConductorReasoningForDisplay(rawText).trim(),
    [rawText],
  );
  const truncated = displayText.length > REASONING_TRUNCATE_AT;

  useEffect(() => {
    if (displayStreaming && expandByDefault) {
      setIsOpen((current) => (current ? current : true));
      return;
    }
    if (!displayStreaming && !userToggledRef.current) {
      setIsOpen((current) => (current ? false : current));
    }
  }, [displayStreaming, expandByDefault]);

  if (pauseForUserInput && isStreaming && !displayText) {
    return null;
  }

  if (!displayStreaming && !displayText) {
    return null;
  }

  return (
    <div data-transcript-thought>
      <Reasoning
        isStreaming={displayStreaming}
        open={isOpen}
        onOpenChange={(open) => {
          // Ignore Radix close noise while tokens are still streaming; the parent
          // keeps this open and accepting the close retriggers an open/close loop.
          if (!open && displayStreaming) return;
          userToggledRef.current = true;
          setIsOpen(open);
        }}
      >
        <ReasoningTrigger className="conductor-reasoning-trigger" />
        <LazyReasoningBody
          displayText={displayText}
          isStreaming={displayStreaming}
          onToggleFullThought={() => setShowFullThought((current) => !current)}
          showFullThought={showFullThought}
          truncated={truncated}
        />
      </Reasoning>
    </div>
  );
}, (prev, next) =>
  prev.part.text === next.part.text
  && prev.part.state === next.part.state
  && prev.expandByDefault === next.expandByDefault
  && prev.pauseForUserInput === next.pauseForUserInput
);

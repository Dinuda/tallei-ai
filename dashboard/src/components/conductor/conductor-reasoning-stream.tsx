"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Tall enough to read ~6–8 lines; older tokens scroll up and fade at the top. */
export const CONDUCTOR_REASONING_STREAM_MAX_HEIGHT = 240;

/** Matches CSS transition duration — Reasoning auto-close waits for this. */
export const CONDUCTOR_REASONING_COLLAPSE_MS = 520;

export function ConductorReasoningStream({
  children,
  isStreaming,
  textLength,
  maxHeight = CONDUCTOR_REASONING_STREAM_MAX_HEIGHT,
}: {
  children: ReactNode;
  isStreaming: boolean;
  textLength: number;
  maxHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [collapseOut, setCollapseOut] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      setCollapseOut(false);
      setPanelHidden(false);
      setExpanded(false);
      wasStreamingRef.current = true;
      return;
    }

    if (wasStreamingRef.current) {
      setCollapseOut(true);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useLayoutEffect(() => {
    if (!isStreaming || expanded || collapseOut) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [collapseOut, expanded, isStreaming, textLength]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== "max-height" || !collapseOut) return;
    setPanelHidden(true);
    setCollapseOut(false);
  };

  if (panelHidden && !isStreaming) {
    return (
      <div className="conductor-reasoning-stream__settled">
        {children}
      </div>
    );
  }

  const showLivePanel = isStreaming || collapseOut;
  const clamped = showLivePanel && !expanded;

  return (
    <div
      className={cn(
        "conductor-reasoning-stream",
        collapseOut && "conductor-reasoning-stream--collapsing",
      )}
    >
      <div
        ref={scrollRef}
        className={cn(
          "conductor-reasoning-stream__scroll",
          clamped && "conductor-reasoning-stream__scroll--live",
          collapseOut && "conductor-reasoning-stream__scroll--collapse-out",
        )}
        onTransitionEnd={handleTransitionEnd}
        style={clamped ? { maxHeight } : undefined}
      >
        {children}
      </div>

      {isStreaming ? (
        <button
          className="conductor-reasoning-stream__toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : "Show full thought"}
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </button>
      ) : null}
    </div>
  );
}

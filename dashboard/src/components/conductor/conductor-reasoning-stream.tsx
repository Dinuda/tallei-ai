"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Tall enough to read ~6–8 lines; older tokens scroll up and fade at the top. */
export const CONDUCTOR_REASONING_STREAM_MAX_HEIGHT = 240;

/** Matches CSS transition duration — Reasoning auto-close waits for this. */
export const CONDUCTOR_REASONING_COLLAPSE_MS = 520;

export function ConductorReasoningStream({
  liveContent,
  settledContent,
  isStreaming,
  isMessageStreaming = false,
  textLength,
  maxHeight = CONDUCTOR_REASONING_STREAM_MAX_HEIGHT,
}: {
  liveContent: ReactNode;
  settledContent: ReactNode;
  isStreaming: boolean;
  /** When true, defer the collapse animation until the assistant turn finishes. */
  isMessageStreaming?: boolean;
  textLength: number;
  maxHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [collapseOut, setCollapseOut] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [collapseHeight, setCollapseHeight] = useState(maxHeight);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hadLiveStreamRef = useRef(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      hadLiveStreamRef.current = true;
      setCollapseOut(false);
      setPanelHidden(false);
      setExpanded(false);
      setCollapseHeight(maxHeight);
      return;
    }

    if (hadLiveStreamRef.current && !isMessageStreaming) {
      setCollapseOut(true);
    }
  }, [isMessageStreaming, isStreaming, maxHeight]);

  useEffect(() => {
    if (!collapseOut) {
      setCollapseHeight(maxHeight);
      return;
    }

    setCollapseHeight(maxHeight);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setCollapseHeight(0);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [collapseOut, maxHeight]);

  useLayoutEffect(() => {
    if (!isStreaming || expanded || collapseOut) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [collapseOut, expanded, isStreaming, textLength]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== "max-height" || !collapseOut || collapseHeight !== 0) return;
    hadLiveStreamRef.current = false;
    setPanelHidden(true);
    setCollapseOut(false);
    setCollapseHeight(maxHeight);
  };

  if (panelHidden && !isStreaming) {
    return (
      <div className="conductor-reasoning-stream__settled">
        {settledContent}
      </div>
    );
  }

  const showLivePanel = isStreaming || collapseOut;
  const clamped = showLivePanel && !expanded;
  const scrollContent = isStreaming || collapseOut || expanded ? liveContent : settledContent;
  const liveScrollStyle = clamped
    ? {
        maxHeight: collapseOut ? collapseHeight : maxHeight,
        minHeight: collapseOut ? 0 : maxHeight,
        opacity: collapseOut && collapseHeight === 0 ? 0 : 1,
      }
    : undefined;

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
        style={liveScrollStyle}
      >
        {scrollContent}
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

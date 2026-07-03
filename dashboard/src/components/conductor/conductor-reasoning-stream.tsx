"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useReasoning } from "@/components/ai-elements/reasoning";
import { cn } from "@/lib/utils";

/** Tall enough to read ~6–8 lines before scrolling. */
export const CONDUCTOR_REASONING_STREAM_MAX_HEIGHT = 240;

/** Matches CSS transition duration — Reasoning auto-close waits for this. */
export const CONDUCTOR_REASONING_COLLAPSE_MS = 520;

export function ConductorReasoningStream({
  liveContent,
  settledContent,
  isStreaming,
  textLength,
  maxHeight = CONDUCTOR_REASONING_STREAM_MAX_HEIGHT,
}: {
  liveContent: ReactNode;
  settledContent: ReactNode;
  isStreaming: boolean;
  textLength: number;
  maxHeight?: number;
}) {
  const { isOpen } = useReasoning();
  const [expanded, setExpanded] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [collapseHeight, setCollapseHeight] = useState(0);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hadStreamRef = useRef(false);
  const wasStreamingRef = useRef(isStreaming);

  const showClamped = isStreaming && !expanded;
  const showLive = isStreaming || collapsing || expanded;

  useEffect(() => {
    if (isStreaming && !wasStreamingRef.current) {
      setExpanded(false);
    }
    wasStreamingRef.current = isStreaming;

    if (isStreaming) {
      hadStreamRef.current = true;
      setCollapsing(false);
      setCollapsed(false);
      return;
    }

    if (hadStreamRef.current) {
      setCollapsing(true);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (isOpen && collapsed) {
      setCollapsed(false);
      setCollapsing(false);
      setCollapseHeight(0);
    }
  }, [collapsed, isOpen]);

  useEffect(() => {
    if (!collapsing) return;

    const fromHeight = scrollRef.current?.getBoundingClientRect().height ?? 0;
    setCollapseHeight(fromHeight);

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
  }, [collapsing]);

  useLayoutEffect(() => {
    if (!showClamped || collapsing) {
      setIsOverflowing(false);
      return;
    }

    const el = scrollRef.current;
    if (!el) return;

    const overflowing = el.scrollHeight > el.clientHeight + 1;
    setIsOverflowing(overflowing);
    if (overflowing) {
      el.scrollTop = el.scrollHeight;
    }
  }, [collapsing, showClamped, textLength]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (!collapsing || collapseHeight !== 0) return;
    if (event.propertyName !== "height") return;
    hadStreamRef.current = false;
    setCollapsed(true);
    setCollapsing(false);
    setCollapseHeight(0);
  };

  if (collapsed && !isStreaming) {
    if (!isOpen) return null;
    return <div className="conductor-reasoning-stream__settled">{settledContent}</div>;
  }

  const scrollStyle = collapsing
    ? { height: collapseHeight, opacity: collapseHeight === 0 ? 0 : 1, overflow: "hidden" as const }
    : showClamped
      ? { maxHeight }
      : undefined;

  return (
    <div className={cn("conductor-reasoning-stream", collapsing && "conductor-reasoning-stream--collapsing")}>
      <div
        ref={scrollRef}
        className={cn(
          "conductor-reasoning-stream__scroll",
          showClamped && "conductor-reasoning-stream__scroll--live",
          isOverflowing && "conductor-reasoning-stream__scroll--masked",
          collapsing && "conductor-reasoning-stream__scroll--collapsing",
        )}
        onTransitionEnd={handleTransitionEnd}
        style={scrollStyle}
      >
        {showLive ? liveContent : settledContent}
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

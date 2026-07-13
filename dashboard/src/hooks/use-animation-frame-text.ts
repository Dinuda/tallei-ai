"use client";

import { useEffect, useRef, useState } from "react";

export type UseAnimationFrameTextOptions = {
  /** Called inside the rAF flush after display text updates (e.g. scroll-to-bottom). */
  onFlush?: (displayText: string) => void;
};

/**
 * Batches rapid string updates to one React commit per animation frame.
 * Uses urgent setState so streamed text paints immediately.
 */
export function useAnimationFrameText(
  value: string | undefined | null,
  options?: UseAnimationFrameTextOptions,
): string {
  const isText = typeof value === "string";
  const text = isText ? value : "";
  const [displayText, setDisplayText] = useState(text);
  const latestTextRef = useRef(text);
  const frameRef = useRef<number | null>(null);
  const onFlushRef = useRef(options?.onFlush);
  onFlushRef.current = options?.onFlush;

  useEffect(() => {
    if (!isText) return;
    latestTextRef.current = value;

    const flush = () => {
      frameRef.current = null;
      const next = latestTextRef.current;
      setDisplayText((current) => (current === next ? current : next));
      onFlushRef.current?.(next);
    };

    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(flush);
  }, [isText, value]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
  }, []);

  if (!isText) return "";
  return displayText;
}

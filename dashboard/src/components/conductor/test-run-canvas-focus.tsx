"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef } from "react";

const BEAT_FOCUS_DURATION_MS = 600;
const OVERVIEW_DURATION_MS = 350;

export function TestRunCanvasFocus({
  focusBeatId,
  beatCount,
  isRunning,
}: {
  focusBeatId: string | null;
  beatCount: number;
  isRunning: boolean;
}) {
  const { fitView } = useReactFlow();
  const wasRunningRef = useRef(false);
  const lastFocusBeatIdRef = useRef<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (isRunning && focusBeatId) {
        const beatChanged = lastFocusBeatIdRef.current !== focusBeatId;
        void fitView({
          nodes: [{ id: focusBeatId }],
          padding: 0.48,
          maxZoom: 0.88,
          duration: beatChanged && wasRunningRef.current
            ? BEAT_FOCUS_DURATION_MS
            : OVERVIEW_DURATION_MS,
        });
        lastFocusBeatIdRef.current = focusBeatId;
        wasRunningRef.current = true;
        return;
      }

      if (wasRunningRef.current || beatCount > 0) {
        void fitView({
          padding: 0.28,
          maxZoom: 0.9,
          duration: OVERVIEW_DURATION_MS,
        });
      }
      lastFocusBeatIdRef.current = null;
      wasRunningRef.current = false;
    });

    return () => cancelAnimationFrame(frame);
  }, [beatCount, fitView, focusBeatId, isRunning]);

  return null;
}

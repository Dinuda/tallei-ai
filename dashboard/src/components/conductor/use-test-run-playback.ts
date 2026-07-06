"use client";

import { useEffect, useState } from "react";

import type { TestRunStoryBeat } from "@/components/conductor/test-run-storyboard-view-model";

const DEFAULT_STEP_MS = 1200;
const APPROVAL_STEP_MS = 1800;

function isFinalOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const row = output as { ok?: boolean; error?: string; steps?: unknown[] };
  return row.ok === true || row.ok === false || Boolean(row.error) || Array.isArray(row.steps);
}

export function useTestRunPlayback(input: {
  beats: TestRunStoryBeat[];
  streaming: boolean;
  output?: unknown;
}): {
  activeBeatIndex: number;
  approvalApproved: boolean;
  resolvedFromOutput: boolean;
} {
  const [activeBeatIndex, setActiveBeatIndex] = useState(0);
  const [approvalApproved, setApprovalApproved] = useState(false);
  const resolvedFromOutput = isFinalOutput(input.output);

  useEffect(() => {
    if (resolvedFromOutput) return undefined;

    const shouldRun = input.streaming || input.beats.length > 0;
    if (!shouldRun) return undefined;

    const currentBeat = input.beats[activeBeatIndex];
    const delay = currentBeat?.kind === "approval" && !approvalApproved
      ? APPROVAL_STEP_MS
      : DEFAULT_STEP_MS;

    const timer = window.setTimeout(() => {
      if (currentBeat?.kind === "approval" && !approvalApproved) {
        setApprovalApproved(true);
        return;
      }

      if (activeBeatIndex < input.beats.length - 1) {
        setActiveBeatIndex((value) => value + 1);
      }
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    activeBeatIndex,
    approvalApproved,
    input.beats,
    input.streaming,
    resolvedFromOutput,
  ]);

  useEffect(() => {
    if (!resolvedFromOutput) return;
    setActiveBeatIndex(input.beats.length - 1);
    setApprovalApproved(true);
  }, [input.beats.length, resolvedFromOutput]);

  return {
    activeBeatIndex,
    approvalApproved,
    resolvedFromOutput,
  };
}

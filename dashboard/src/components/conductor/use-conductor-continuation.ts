"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

import type { ConductorContinuationIntent } from "@/lib/conductor-continuation-intent";
import type { ChatStatus } from "@/components/conductor/conductor-shared";

type UseConductorContinuationOptions = {
  continuationIntent: ConductorContinuationIntent;
  chatStatus: ChatStatus;
  hydrationReady: boolean;
  /** Shared ref set by any real in-session user action; never set on initial hydration. */
  sessionActionRef: MutableRefObject<boolean>;
  sendMessage: () => void | Promise<void>;
};

/**
 * Executes server-projected phase handoffs after an in-session action.
 * - UI-tool answers are handled by `sendAutomaticallyWhen` in `useChat` (no user message added).
 * - Phase handoffs fire here when the server signals `auto_continue:phase_handoff` AND
 *   `sessionActionRef` is set, guaranteeing this never fires on plain page refresh.
 * - Each handoffId is consumed at most once per session — prevents re-firing the same
 *   handoff if the GET poll is slow and `continuationIntent` hasn't updated yet after
 *   the stream finishes.
 */
export function useConductorContinuation({
  continuationIntent,
  chatStatus,
  hydrationReady,
  sessionActionRef,
  sendMessage,
}: UseConductorContinuationOptions): void {
  const consumedHandoffIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!hydrationReady || chatStatus !== "ready") return;
    if (continuationIntent.action !== "auto_continue") return;
    if (continuationIntent.trigger !== "phase_handoff") return;
    if (!sessionActionRef.current) return;

    const blockedReasons = new Set([
      "required_tool_not_called",
      "repeated_no_progress",
      "no_actionable_next_tool",
    ]);
    if (blockedReasons.has(continuationIntent.reason)) return;

    const { handoffId } = continuationIntent;
    if (!handoffId) return;
    if (consumedHandoffIdsRef.current.has(handoffId)) return;

    consumedHandoffIdsRef.current.add(handoffId);
    void sendMessage();
  }, [chatStatus, continuationIntent, hydrationReady, sendMessage, sessionActionRef]);
}

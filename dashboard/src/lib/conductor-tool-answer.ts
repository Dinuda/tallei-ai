"use client";

import { consumeStream, type UIMessage } from "ai";

import { apiFetch } from "@/lib/api-fetch";
import { formatApiError } from "@/lib/format-api-error";
import {
  IDLE_CONTINUATION_INTENT,
  parseContinuationIntent,
  type ConductorContinuationIntent,
} from "@/lib/conductor-continuation-intent";
import type { ConductorBuildPhase, PhaseHandoffProgress } from "@/components/conductor/conductor-shared";
import type { LoopEventTriggerStatus } from "@/components/conductor/conductor-spec-sheet";

export type ConductorLoopMetaPatch = {
  loopName?: string;
  spec?: Record<string, unknown> | null;
  missingSlots?: string[];
  status?: string;
  compiledPlanId?: string | null;
  eventTrigger?: LoopEventTriggerStatus | null;
  buildPhase?: ConductorBuildPhase | null;
  phaseProgress?: PhaseHandoffProgress | null;
  latestPhaseTurn?: {
    phase?: string;
    parentArtifactHash?: string;
    continuation?: string;
    nextPhase?: string;
    handoffId?: string;
    pendingToolCallId?: string;
    resumeAfterAnswer?: boolean;
    outcome?: string;
    resolutionReason?: string;
    stepsUsed?: number;
  } | null;
  continuationIntent?: ConductorContinuationIntent;
};

/**
 * Submit a UI-tool answer to the server-owned Conductor session.
 * The response is an SSE stream (same as POST /chat); we consume it then
 * refresh authoritative transcript + meta from GET /api/loops/:id.
 */
export async function submitConductorToolAnswer(input: {
  loopId: string;
  tool: string;
  toolCallId: string;
  output: unknown;
  onMeta: (meta: ConductorLoopMetaPatch) => void;
  setMessages: (messages: UIMessage[]) => void;
}): Promise<void> {
  const res = await apiFetch(`/api/loops/${input.loopId}/chat/tool-answer`, {
    method: "POST",
    body: JSON.stringify({
      toolCallId: input.toolCallId,
      tool: input.tool,
      output: input.output,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(formatApiError(data, "Could not submit that answer."));
  }

  // Drain the session SSE so the server finishes bookkeeping before we refresh.
  if (res.body) {
    await consumeStream({
      stream: res.body,
      onError: (error) => {
        console.error("[conductor/tool-answer] stream error:", error);
      },
    });
  }

  const metaRes = await apiFetch(`/api/loops/${input.loopId}`);
  const data = await metaRes.json();
  if (!metaRes.ok) {
    throw new Error(formatApiError(data, "Could not refresh Conductor state."));
  }

  input.onMeta({
    loopName: typeof data.loop?.name === "string" ? data.loop.name : undefined,
    spec: data.spec ?? null,
    missingSlots: Array.isArray(data.missingSlots) ? data.missingSlots : undefined,
    status: typeof data.loop?.status === "string" ? data.loop.status : undefined,
    compiledPlanId: data.buildChat?.compiledPlanId ?? null,
    eventTrigger: data.eventTrigger ?? null,
    buildPhase: typeof data.buildProgress?.internalPhase === "string"
      ? data.buildProgress.internalPhase as ConductorBuildPhase
      : null,
    phaseProgress: data.buildProgress?.phaseProgress ?? null,
    latestPhaseTurn: data.buildProgress?.latestPhaseTurn ?? null,
    continuationIntent: parseContinuationIntent(data.buildProgress?.continuationIntent)
      ?? IDLE_CONTINUATION_INTENT,
  });

  if (Array.isArray(data.chatMessages)) {
    input.setMessages(data.chatMessages as UIMessage[]);
  }
}

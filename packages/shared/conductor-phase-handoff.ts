import type { ConductorBuildPhase } from "./conductor-build-phase.js";

/** Server-projected phase progress mirrored on GET /chat meta and client UI. */
export type PhaseHandoffProgress = {
  phase?: ConductorBuildPhase | string;
  goal?: string;
  completionCriteria?: string[];
  maxSteps?: number;
  autoAdvance?: boolean;
  handoffPending?: boolean;
  nextTool?: string | null;
  reason?: string;
  status?: "pending" | "in_progress" | "complete" | "waiting" | string;
  terminal?: boolean;
  pendingUiTool?: {
    toolCallId: string;
    toolName: string;
    input?: unknown;
  } | null;
};

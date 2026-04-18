export const ONBOARDING_STATUSES = [
  "queued",
  "running",
  "checkpoint_required",
  "completed",
  "failed",
  "canceled",
] as const;

export const ONBOARDING_STATES = [
  "queued",
  "browser_started",
  "claude_authenticated",
  "connector_connected",
  "project_upserted",
  "instructions_applied",
  "verified",
] as const;

export type OnboardingStatus = typeof ONBOARDING_STATUSES[number];
export type OnboardingState = typeof ONBOARDING_STATES[number];

export interface OnboardingCheckpoint {
  type: "auth" | "captcha" | "manual_review";
  blockedState: Exclude<OnboardingState, "queued">;
  message: string;
  resumeHint: string;
  actionUrl?: string;
}

export interface OnboardingSession {
  id: string;
  userId: string;
  status: OnboardingStatus;
  currentState: OnboardingState;
  projectName: string;
  checkpoint: OnboardingCheckpoint | null;
  metadata: Record<string, unknown>;
  lastError: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

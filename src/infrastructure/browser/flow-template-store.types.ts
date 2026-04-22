import type { OnboardingState } from "../../orchestration/browser/claude-onboarding.types.js";

export type OnboardingActionState = Exclude<OnboardingState, "queued">;

export interface WinningAction {
  type: "click" | "fill" | "goto";
  selector: string;
  value?: string;
}

export interface FlowTemplate {
  state: OnboardingActionState;
  actions: WinningAction[];
  successCount: number;
  isLearned: boolean;
  lastSucceededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

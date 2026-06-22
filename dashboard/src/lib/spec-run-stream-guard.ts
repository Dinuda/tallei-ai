const AUTO_START_PREFIX = "spec-run-auto:";

export function hasSpecRunAutoStartAttempted(runId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(`${AUTO_START_PREFIX}${runId}`) === "1";
  } catch {
    return false;
  }
}

export function markSpecRunAutoStartAttempted(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${AUTO_START_PREFIX}${runId}`, "1");
  } catch {
    // Ignore quota / private-mode errors.
  }
}

export function clearSpecRunAutoStartAttempted(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`${AUTO_START_PREFIX}${runId}`);
  } catch {
    // Ignore.
  }
}

export function canKickSpecRunStream(chatStatus: string): boolean {
  return chatStatus !== "streaming" && chatStatus !== "submitted";
}

type ContinueRunStep = {
  step_index: number;
  status: string;
  attempt?: number;
};

export function shouldContinueRunStream(input: {
  runStatus: string;
  steps: ContinueRunStep[];
  pendingInteraction: boolean;
  chatStatus: string;
  totalAgents: number;
}): boolean {
  if (input.pendingInteraction) return false;
  if (input.chatStatus === "streaming" || input.chatStatus === "submitted") return false;
  if (input.runStatus !== "running") return false;
  if (input.totalAgents <= 0) return false;

  const byIndex = new Map<number, ContinueRunStep>();
  for (const step of input.steps) {
    const existing = byIndex.get(step.step_index);
    if (!existing || (step.attempt ?? 0) >= (existing.attempt ?? 0)) {
      byIndex.set(step.step_index, step);
    }
  }
  const latest = [...byIndex.values()].sort((left, right) => left.step_index - right.step_index);
  if (latest.length === 0) return false;

  if (latest.some((step) => step.status === "waiting_for_interaction")) return false;
  if (latest.some((step) => step.status === "running")) return true;

  const succeeded = latest.filter((step) => step.status === "succeeded").length;
  return succeeded > 0 && succeeded < input.totalAgents;
}

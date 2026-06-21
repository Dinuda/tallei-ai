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

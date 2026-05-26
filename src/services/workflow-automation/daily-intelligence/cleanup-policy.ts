import type { RunMemoryCleanupOptions } from "../../memory-cleanup.js";

export function buildDailyCleanupOptions(firstProcessedRun: boolean): RunMemoryCleanupOptions {
  if (firstProcessedRun) {
    return {
      runReason: "daily_intelligence",
      dryRun: false,
      processAll: false,
      selectionStrategy: "newest_hybrid",
      maxMemories: 50,
      newestLimit: 30,
      interestingLimit: 20,
    };
  }

  return {
    runReason: "daily_intelligence",
    dryRun: false,
    maxMemories: 200,
  };
}

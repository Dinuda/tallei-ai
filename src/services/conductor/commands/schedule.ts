import { selectedLoopTrigger, type LoopBuildContract } from "../domain/build-contract.js";

export function saveScheduleFromBuildContract(buildContract: LoopBuildContract): {
  cron: string;
  timezone: string;
} {
  const trigger = selectedLoopTrigger(buildContract);
  if (trigger?.mode === "schedule") {
    return { cron: trigger.cron, timezone: trigger.timezone };
  }
  throw new Error("Build contract must resolve an approved schedule before saving.");
}

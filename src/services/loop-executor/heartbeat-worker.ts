import { config } from "../../config/index.js";
import { dispatchLoopHeartbeatJobs } from "./heartbeat-dispatch.js";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTickRunning = false;

export function startLoopHeartbeatWorker(): void {
  if (heartbeatTimer || config.loopExecutorHeartbeatDispatch !== "internal") return;
  heartbeatTimer = setInterval(() => {
    if (heartbeatTickRunning) return;
    heartbeatTickRunning = true;
    void dispatchLoopHeartbeatJobs({ source: "internal" })
      .catch((error) => console.error("[loop-executor] heartbeat dispatch failed:", error))
      .finally(() => {
        heartbeatTickRunning = false;
      });
  }, config.loopExecutorHeartbeatPollMs);
  heartbeatTimer.unref?.();
}

export function stopLoopHeartbeatWorker(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatTickRunning = false;
}

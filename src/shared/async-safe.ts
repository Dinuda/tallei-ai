import { config } from "../config/index.js";

export function runAsyncSafe(task: () => Promise<void>, label: string): void {
  setImmediate(() => {
    void task().catch((error) => {
      if (config.nodeEnv !== "production") {
        console.error(`[async] ${label} failed`, error);
      }
    });
  });
}

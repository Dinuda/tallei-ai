import { startMemoryGraphWorker, stopMemoryGraphWorker } from "../orchestration/graph/extract-graph.worker.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  startMemoryGraphWorker();
  workersRunning = true;
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  stopMemoryGraphWorker();
  workersRunning = false;
}

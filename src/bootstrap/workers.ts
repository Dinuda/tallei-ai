let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
}

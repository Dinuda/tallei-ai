import {
  startUploadedFileIngestWorker,
  stopUploadedFileIngestWorker,
} from "../services/uploaded-file-ingest-jobs.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startUploadedFileIngestWorker();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopUploadedFileIngestWorker();
}

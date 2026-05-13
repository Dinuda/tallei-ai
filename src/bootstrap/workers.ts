import {
  startUploadedFileIngestWorker,
  stopUploadedFileIngestWorker,
} from "../services/uploaded-file-ingest-jobs.js";
import {
  startVertexDocumentBackfillWorker,
  stopVertexDocumentBackfillWorker,
} from "../services/vertex-document-backfill.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
}

import {
  startUploadedFileIngestWorker,
  stopUploadedFileIngestWorker,
} from "../services/uploaded-file-ingest-jobs.js";
import {
  startChatGptImportWorker,
  stopChatGptImportWorker,
} from "../services/chatgpt-import/jobs.service.js";
import {
  startVertexDocumentBackfillWorker,
  stopVertexDocumentBackfillWorker,
} from "../services/vertex-document-backfill.js";
import {
  startLoopRuntimeWorker,
  startSpecLoopScheduler,
  stopLoopRuntimeWorker,
  stopSpecLoopScheduler,
} from "../services/loop-runtime/index.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startChatGptImportWorker();
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  startLoopRuntimeWorker();
  startSpecLoopScheduler();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopChatGptImportWorker();
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopLoopRuntimeWorker();
  stopSpecLoopScheduler();
}

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
import { startLoopRuntimeWorker, stopLoopRuntimeWorker } from "../services/loop-runtime/index.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startChatGptImportWorker();
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  startLoopRuntimeWorker();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopChatGptImportWorker();
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopLoopRuntimeWorker();
}

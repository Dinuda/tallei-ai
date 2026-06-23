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
  startSpecLoopScheduler,
  stopSpecLoopScheduler,
} from "../services/conductor/runtime/index.js";
import { isTemporalEnabled } from "../temporal/client.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startChatGptImportWorker();
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  if (!isTemporalEnabled()) {
    startSpecLoopScheduler();
  }
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopChatGptImportWorker();
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopSpecLoopScheduler();
}

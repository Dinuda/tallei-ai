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
  startLoopExecutorScheduler,
  startLoopHeartbeatWorker,
  stopLoopExecutorScheduler,
  stopLoopHeartbeatWorker,
} from "../services/loop-executor/index.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  startChatGptImportWorker();
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  startLoopExecutorScheduler();
  startLoopHeartbeatWorker();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopChatGptImportWorker();
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopLoopExecutorScheduler();
  stopLoopHeartbeatWorker();
}

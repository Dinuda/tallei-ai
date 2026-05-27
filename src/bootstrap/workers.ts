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
  executeWorkflowRunSdkHandler,
  runDailyIntelligencePassForUserInternal,
  syncWorkflowRunStatusFromSdk,
  startDailyIntelligenceWorker,
  stopDailyIntelligenceWorker,
} from "../services/workflow-automation.js";
import {
  registerWorkflowSdkRunProcessor,
  registerWorkflowSdkRunStatusObserver,
  startWorkflowSdkRuntime,
  stopWorkflowSdkRuntime,
} from "../services/workflow-sdk-runtime.js";
import {
  startLoopExecutorScheduler,
  stopLoopExecutorScheduler,
} from "../services/loop-executor/index.js";
import {
  dailyIntelligenceWorkflowInputSchema,
  workflowRunWorkflowInputSchema,
  WORKFLOW_DEFINITIONS,
} from "../orchestration/workflows/definitions.js";
import { getPlanForTenant } from "../infrastructure/auth/tenancy.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  registerWorkflowSdkRunProcessor(async (run) => {
    if (run.workflowName === WORKFLOW_DEFINITIONS.DAILY_INTELLIGENCE) {
      const parsed = dailyIntelligenceWorkflowInputSchema.parse(run.input);
      const plan = await getPlanForTenant(parsed.tenantId);
      const result = await runDailyIntelligencePassForUserInternal({
        tenantId: parsed.tenantId,
        userId: parsed.userId,
        authMode: "internal",
        plan,
      }, { skipSdkLifecycle: true });
      return { output: result };
    }

    if (run.workflowName === WORKFLOW_DEFINITIONS.WORKFLOW_RUN) {
      const parsed = workflowRunWorkflowInputSchema.parse(run.input);
      const executionTenant = run.executionContext?.tenantId;
      const executionUser = run.executionContext?.userId;
      if (typeof executionTenant !== "string" || typeof executionUser !== "string") {
        throw new Error("Missing execution context for workflow run");
      }
      const plan = await getPlanForTenant(executionTenant);
      return executeWorkflowRunSdkHandler({
        auth: {
          tenantId: executionTenant,
          userId: executionUser,
          authMode: "internal",
          plan,
        },
        runId: parsed.runId,
        workflowId: parsed.workflowId,
        runMode: parsed.runMode,
        scheduledFor: parsed.scheduledFor,
      });
    }

    return { output: { ignored: true, workflowName: run.workflowName } };
  });
  registerWorkflowSdkRunStatusObserver(async ({ runId, status }) => {
    await syncWorkflowRunStatusFromSdk({
      sdkRunId: runId,
      sdkStatus: status,
    });
  });

  void startWorkflowSdkRuntime().catch((error) => {
    console.error("[workflow-sdk] failed to start runtime:", error);
  });
  startChatGptImportWorker();
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  startDailyIntelligenceWorker();
  startLoopExecutorScheduler();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopChatGptImportWorker();
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopDailyIntelligenceWorker();
  stopLoopExecutorScheduler();
  void stopWorkflowSdkRuntime().catch((error) => {
    console.error("[workflow-sdk] failed to stop runtime:", error);
  });
}

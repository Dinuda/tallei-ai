import {
  startUploadedFileIngestWorker,
  stopUploadedFileIngestWorker,
} from "../services/uploaded-file-ingest-jobs.js";
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
  dailyIntelligenceWorkflowInputSchema,
  workflowRunWorkflowInputSchema,
  WORKFLOW_DEFINITIONS,
} from "../orchestration/workflows/definitions.js";

let workersRunning = false;

export function startWorkers(): void {
  if (workersRunning) return;
  workersRunning = true;
  registerWorkflowSdkRunProcessor(async (run) => {
    if (run.workflowName === WORKFLOW_DEFINITIONS.DAILY_INTELLIGENCE) {
      const parsed = dailyIntelligenceWorkflowInputSchema.parse(run.input);
      const result = await runDailyIntelligencePassForUserInternal({
        tenantId: parsed.tenantId,
        userId: parsed.userId,
        authMode: "internal",
        plan: "pro",
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
      return executeWorkflowRunSdkHandler({
        auth: {
          tenantId: executionTenant,
          userId: executionUser,
          authMode: "internal",
          plan: "pro",
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
  startUploadedFileIngestWorker();
  startVertexDocumentBackfillWorker();
  startDailyIntelligenceWorker();
}

export function stopWorkers(): void {
  if (!workersRunning) return;
  workersRunning = false;
  stopUploadedFileIngestWorker();
  stopVertexDocumentBackfillWorker();
  stopDailyIntelligenceWorker();
  void stopWorkflowSdkRuntime().catch((error) => {
    console.error("[workflow-sdk] failed to stop runtime:", error);
  });
}

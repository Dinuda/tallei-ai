import type { SpecRunTrigger } from "../services/loop-runtime/spec-runner.js";

export type LoopRunWorkflowInput = {
  tenantId: string;
  userId: string;
  workflowId: string;
  runId?: string;
  trigger: SpecRunTrigger;
};

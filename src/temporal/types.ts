import type { SpecRunTrigger } from "../services/conductor/runtime/spec-runner.js";

export type LoopRunWorkflowInput = {
  tenantId: string;
  userId: string;
  workflowId: string;
  runId?: string;
  trigger: SpecRunTrigger;
};

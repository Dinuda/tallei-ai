/**
 * loop-executor — Public barrel exports.
 *
 * Core execution is domain-agnostic; opt-in presets (e.g. newsletter) live under ./presets/.
 */

// Design-time
export {
  buildLoopDefinition,
  createLoopWorkflow,
  deleteLoopWorkflow,
  getLoopWorkflow,
  listLoopWorkflows,
  requireLoopAdmin,
} from "./creator.js";
export {
  buildPlanFromAgentGraph,
  isDynamicPlanDefinition,
  readLoopDefinition,
} from "./plan.js";
export { assignLoopToWorkspace, createWorkspace, listWorkspaces } from "./workspace.js";
export { nextCronRunAt, validateFiveFieldCron } from "./cron.js";
export {
  getEffectiveLoopConstraints,
  listAllowedLoopTools,
  listLoopTools,
  validateAgentRoster,
  validateToolAssignments,
} from "./tool-catalog.js";

// Execution — run lifecycle
export {
  addLoopRunComment,
  executeLoopWorkflow,
  getLoopRunDebugLogs,
  getLoopRun,
  getLoopRunRoster,
  listLoopRunArtifacts,
  listLoopRunComments,
  listLoopRunTasks,
  markRunBlocked,
  rerunLoopRunTask,
  runAgentHeartbeat,
  runCeoFinalizeHeartbeat,
  runCeoStrategyHeartbeat,
  updateLoopRunNewsletterDraft,
  updateLoopRunRoster,
} from "./executor.js";
export { buildCeoStrategyOutput, materializeTasksFromPlan, materializeTasksFromRoster } from "./run-strategy.js";

// Execution — approvals
export {
  applyEmailApprovalResult,
  approveLoopRunApprovalToken,
  approveLoopRunFromUi,
  approveLoopStrategy,
  ensureRunApprovalNotification,
  resumeLoopRunExecution,
  submitLoopRunInput,
  uploadDeliveryRecipients,
  uploadLoopRunContacts,
} from "./approval.js";

// Execution — gates
export {
  approveLoopRunGate,
  approveLoopRunGateApprovalToken,
  listLoopRunGates,
  rejectLoopRunGate,
  submitLoopRunGateInput,
} from "./gates.js";

// Execution — delivery
export { runDistributionHeartbeat, ensureDeliveryRunFinished, readDeliveryCompletionState } from "./distribution.js";

// Scheduling
export { dispatchLoopHeartbeatJobs } from "./heartbeat-dispatch.js";
export { dispatchDueLoopWorkflows, startLoopExecutorScheduler, stopLoopExecutorScheduler } from "./scheduler.js";
export { startLoopHeartbeatWorker, stopLoopHeartbeatWorker } from "./heartbeat-worker.js";

// Presets (opt-in)
export { newsletterPreset } from "./presets/newsletter.js";
export { getLoopPreset } from "./presets/registry.js";

// Agentic loop engine (v3)
export {
  LOOP_ENGINE_VERSION,
  designLoopFromIntent,
  runEngineAgentStep,
  runEngineDeliveryHeartbeat,
  recallForDesigner,
  evaluateAgentGoal,
  isEngineV3Definition,
} from "../loop-engine/index.js";

// Types
export {
  LOOP_DEFINITION_VERSION,
  loopAgentGraphSchema,
  loopDefinitionSchema,
  loopPlanSchema,
  loopRunAgentSchema,
  loopStageSchema,
  loopToolAssignmentSchema,
} from "./types.js";

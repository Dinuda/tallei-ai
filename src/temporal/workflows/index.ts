export { loopRunWorkflow } from "./loop-run.workflow.js";
// Temporal persists the workflow type in execution history. Keep the previous
// name exported so executions started before the rename can still be replayed.
export { loopRunWorkflow as specRunWorkflowV1 } from "./loop-run.workflow.js";

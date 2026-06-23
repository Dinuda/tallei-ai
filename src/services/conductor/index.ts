export {
  dispatchWorkflowBuilderCommand,
  executeWorkflowBuilderToolNow,
  getWorkflowBuilderCommand,
  retryFailedBuilderCommand,
  type BuilderToolName,
} from "./commands/dispatcher.js";
export {
  createWorkflowBuilderSession,
  requireWorkflowBuilderSession,
  findWorkflowBuilderSessionBySpec,
  updateWorkflowBuilderSession,
  updateWorkflowBuilderSessionState,
  saveWorkflowBuilderAnalyzerUsage,
  replaceWorkflowBuilderMessages,
  persistLoopBuilderChatMessages,
  listWorkflowBuilderMessages,
  sanitizeLoopBuilderChatMessages,
  normalizeWorkflowBuilderMessages,
  recordWorkflowBuilderAnalyzerPhaseTrace,
  recordWorkflowBuilderChatTurnTrace,
  appendWorkflowBuilderTrace,
  appendWorkflowBuilderPhaseHistory,
  setPendingPhaseRevision,
  clearPendingPhaseRevision,
  phaseAfterRequirementsResolved,
  type WorkflowBuilderPhase,
  type WorkflowBuilderSession,
} from "./services/session.service.js";
export {
  getLoopSpec,
  listLoopSpecs,
  mapLoopSpecRowForTest,
  approvedSpecSnapshot,
  compileEnrichedRuntimeSpecSnapshot,
  compileRuntimeSpecSnapshotAsync,
  buildRunnerSpecFromBuildContract,
  persistApprovedLoopSpecSnapshot,
  renderSpecMarkdown,
  specSemanticIssues,
  type LoopSpecView,
  type LoopSpecRow,
} from "./services/spec.service.js";
export { planAgents, atomicityIssues } from "./plan/spec-compiler.js";
export { saveLoopFromSpec, type LoopBuilderProposal } from "./services/save-loop.service.js";
export {
  allocateAgentAvatars,
  bindAgentAvatar,
  loopSpecExists,
  type AgentAvatarView,
} from "./services/avatar.service.js";
export {
  commitBuilderConnectorSetup,
  getBuilderConnectorSetup,
  refreshBuilderConnectorAvailability,
  resolveBuilderConnectorRequirement,
  startBuilderConnectorSetup,
  testBuilderConnectorSetup,
  updateBuilderConnectorSetupGoals,
  updateBuilderConnectorSetupGraph,
  type BuilderConnectorChecklist,
} from "./services/connector.service.js";
export { saveBuilderArtifactBundle } from "./services/artifacts.service.js";
export {
  loopBuilderOpenAiModel,
  loopBuilderOpenAiChat,
  loopBuilderStreamMaxOutputTokens,
  loopBuilderStreamProviderOptions,
  isLoopBuilderReasoningModel,
} from "./llm/openai-chat.js";
export { createLoopBuilderToolCallRepair } from "./repair/tool-call-repair.js";
export {
  emptyLoopBuilderUsage,
  mergeLoopBuilderUsageTotals,
  reportLoopBuilderProgress,
  usageFromLanguageModelStep,
  type LoopBuilderProgressEvent,
  type LoopBuilderUsage,
} from "./utils/progress.js";
export {
  normalizeSaveLoopInput,
  saveLoopInputSchema,
  saveLoopRequestSchema,
} from "./inputs/save-loop-input.js";
export {
  dicebearDylanUrl,
  pickUniqueDisplayName,
  resolveAgentRole,
  slugifyAgentId,
} from "./services/personas/agent-personas.js";
export { filterAndRankToolkitSearch, scoreToolkitRelevance } from "./ranking/app-search-ranking.js";
export {
  loopIntentAnalysisSchema,
  loopIntentContextSchema,
  type LoopIntentAnalysis,
  type LoopIntentContext,
} from "./contracts/intent-context.js";
export {
  loopBuildContractSchema,
  persistedLoopBuildContractSchema,
  deriveLoopBuildContract,
  resolveBuildRequirement,
  assertBuildContractReady,
  unresolvedBuildRequirements,
  slimUnresolvedRequirements,
  hydrateBuildContractArtifactBundle,
  selectedConnectorActionSlugs,
  selectedArtifactContract,
  selectedLoopTrigger,
  selectedGroundingSources,
  selectedExternalDataToolkits,
  selectedStableInputs,
  selectedConnectorAccountId,
  type LoopBuildContract,
  type AnyLoopBuildContract,
} from "./domain/build-contract.js";
export {
  noSlopSpecSchema,
  noSlopSpecDraftSchema,
  noSlopSpecSnapshotSchema,
  noSlopSpecStatusSchema,
  type NoSlopSpec,
  noSlopSpecAgentSchema,
  type NoSlopSpecAgent,
  type NoSlopSpecSnapshot,
  type NoSlopSpecStatus,
} from "./contracts/spec-contracts.js";
export { validateContractData, stripToSchema, type DataContract } from "./contracts/data-contract.js";
export { actionSlugFromToolRef, contractActionSlug } from "./domain/tool-roles.js";
export { loadWorkflowUserProfile } from "./domain/workflow-user-profile.js";

// Workflow persistence & verification
export {
  createLoopFromDefinition,
  deleteLoopWorkflow,
  getLoopWorkflow,
  listLoopWorkflows,
} from "./services/loop-workflow.service.js";
export {
  assignLoopToWorkspace,
  createWorkspace,
  listWorkspaces,
} from "../workspace/index.js";
export {
  confirmWorkflowVerification,
  getWorkflowVerification,
  runWorkflowVerification,
} from "./services/verification.service.js";
export { LOOP_DEFINITION_VERSION, type LoopDefinition } from "./workflow/types.js";
export { normalizeDesignCron, nextCronRunAt, validateFiveFieldCron } from "./domain/schedule-cron.js";
export { listAvailableLoopToolsForAuth } from "./services/tool-catalog.service.js";

// Spec run execution (formerly loop-runtime)
export {
  cancelSpecLoopRun,
  createSpecLoopRun,
  executeSpecRunHeadless,
  getSpecRunMessages,
  getSpecRunProjection,
  isSpecDrivenWorkflow,
  listSpecLoopRuns,
  retrySpecLoopRun,
  runSpecLoopHeadless,
  scheduleTriggerLabel,
  saveSpecRunAsLoop,
  startSpecManualLoopRun,
  streamSpecRunChat,
  getSpecRunEditorialProjection,
  saveCanvasEmailArtifact,
  handleSpecRunInteractionCommand,
  startSpecLoopScheduler,
  stopSpecLoopScheduler,
  getWorkflowTriggerActivity,
  type SpecRunTrigger,
  type SpecRunTriggerSource,
} from "./runtime/index.js";
export { normalizeRunMessages } from "./runtime/run-messages.js";
export { definitionFromApprovedSpec } from "./runtime/spec-run-types.js";
export { compileSpecRunPlan } from "./runtime/spec-run-plan.js";

import { z } from "zod";

import { intentAnalysisSchema } from "./intent-discovery.js";

export {
  askQuestionOptionSchema,
  askQuestionInputSchema,
  askQuestionOutputSchema,
  type AskQuestionInput,
  type AskQuestionOutput,
  pickConnectorAppInputSchema,
  type PickConnectorAppInput,
  listTriggersInputSchema,
  listActionsInputSchema,
  connectToolkitInputSchema,
  listWorkspaceConnectorsInputSchema,
  confirmOutcomeBriefActionSchema,
  type ConfirmOutcomeBriefAction,
  confirmOutcomeBriefInputSchema,
  confirmOutcomeBriefOutputSchema,
  resolveConfirmOutcomeBriefAction,
  resolveConfirmOutcomeBriefActionFromSelection,
  type ConfirmOutcomeBriefInput,
  type ConfirmOutcomeBriefOutput,
  presentReplyOptionsInputSchema,
  presentReplyOptionsOutputSchema,
  type PresentReplyOptionsInput,
  type PresentReplyOptionsOutput,
  discoverBindingsInputSchema,
  type DiscoverBindingsInput,
  resolveBindingsInputSchema,
  type ResolveBindingsInput,
  discoverConnectorsForBlueprintInputSchema,
  type DiscoverConnectorsForBlueprintInput,
  compileLoopInputSchema,
  activateLoopInputSchema,
  type CompileLoopInput,
  type ActivateLoopInput,
  testRunScenarioSchema,
  testRunLoopInputSchema,
  type TestRunScenario,
  type TestRunLoopInput,
} from "@tallei/conductor-tools/input-schemas.js";

export {
  conductorExecutionMetadataSchema,
  type ConductorExecutionMetadata,
  type PhaseExecutionContract,
  readConductorExecutionMetadata,
  isRecoverableConductorExecution,
  isConductorBuildPhase,
} from "@tallei/conductor-tools/execution-metadata.js";

export { BUILD_PHASES, buildPhaseSchema } from "@tallei/conductor-tools/build-phase.js";

export const analyzeIntentInputSchema = intentAnalysisSchema;
export type AnalyzeIntentInput = z.infer<typeof analyzeIntentInputSchema>;

export {
  presentAgentTeamInputSchema,
  presentAgentTeamOutputSchema,
  type PresentAgentTeamInput,
  type PresentAgentTeamOutput,
  type AgentTeamSpecialist,
} from "./present-agent-team.js";

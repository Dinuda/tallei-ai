import { randomUUID } from "crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import {
  confirmWorkflowVerification,
  getWorkflowVerification,
  initializeWorkflowVerification,
  runWorkflowVerification,
} from "../services/verification.service.js";
import { createSpecLoopRun, runSpecLoopHeadless } from "../runtime/index.js";
import { discoverToolsForLoopBuild } from "../../connectors/composio-discovery.js";
import { listComposioTriggerTypes } from "../../connectors/composio.js";
import { normalizeDiscoveredToolContracts } from "../../connectors/platform-integrations.js";
import { refreshBuilderConnectorAvailability } from "../services/connector.service.js";
import { normalizeGetAvailableToolsInput } from "../inputs/get-available-tools-input.js";
import {
  loopIntentAnalysisSchema,
  loopIntentContextSchema,
} from "../contracts/intent-context.js";
import {
  emptyLoopBuilderUsage,
  reportLoopBuilderProgress,
  runWithLoopBuilderProgress,
  sanitizeLoopBuilderProgressDetails,
  type LoopBuilderProgressEvent,
  type LoopBuilderUsage,
} from "../utils/progress.js";
import { compileEnrichedRuntimeSpecSnapshot } from "../services/spec.service.js";
import { saveLoopFromSpec } from "../services/save-loop.service.js";
import {
  assertBuildContractReady,
  deriveLoopBuildContract,
  resolveBuildRequirement,
  unresolvedBuildRequirements,
} from "../domain/build-contract.js";
import {
  createWorkflowBuilderSession,
  requireWorkflowBuilderSession,
  updateWorkflowBuilderSession,
  phaseAfterRequirementsResolved,
  type WorkflowBuilderPhase,
} from "../services/session.service.js";
import {
  completeCommand,
  failCommand,
  findRetryableCommandRow,
  findWorkflowBuilderCommandRow,
  insertWorkflowBuilderCommand,
  markCommandRunning,
  updateCommandProgress,
  type CommandRow,
} from "../data/command.repository.js";
import type { BuilderToolName } from "../contracts/builder-types.js";

export type { BuilderToolName } from "../contracts/builder-types.js";

type WorkflowBuilderCommandView = {
  jobId: string;
  sessionId: string;
  kind: string;
  toolName: BuilderToolName;
  status: "pending" | "running" | "completed" | "failed" | "rejected";
  createdAt: string;
  updatedAt: string;
  events: LoopBuilderProgressEvent[];
  usage: LoopBuilderUsage;
  proposal?: unknown;
  spec?: unknown;
  intentAnalysis?: unknown;
  composioSessionId?: string;
  result?: Record<string, unknown>;
  error?: string;
};

const commandQueues = new Map<string, Promise<void>>();

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function legacyKind(toolName: BuilderToolName): string {
  return ({
    getAvailableTools: "analyze-intent",
    resolveBuildRequirement: "resolve-build-requirement",
    refreshConnectorAvailability: "refresh-connector-availability",
    saveLoop: "save",
    runBuilderTest: "run-builder-test",
    runVerification: "run-verification",
    confirmActivation: "confirm-activation",
  } satisfies Record<BuilderToolName, string>)[toolName];
}

function mapCommand(row: CommandRow): WorkflowBuilderCommandView {
  const result = row.result_json ?? {};
  return {
    jobId: row.id,
    sessionId: row.session_id,
    kind: legacyKind(row.tool_name),
    toolName: row.tool_name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    events: row.events_json ?? [],
    usage: row.usage_json ?? emptyLoopBuilderUsage(),
    ...(result.proposal ? { proposal: result.proposal } : {}),
    ...(result.spec ? { spec: result.spec } : {}),
    ...(result.intentAnalysis ? { intentAnalysis: result.intentAnalysis } : {}),
    ...(typeof result.composioSessionId === "string" ? { composioSessionId: result.composioSessionId } : {}),
    ...(row.result_json ? { result } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
  };
}

function requirePhase(actual: WorkflowBuilderPhase, allowed: WorkflowBuilderPhase[], tool: BuilderToolName): void {
  if (!allowed.includes(actual)) {
    throw new Error(`${tool} is not available while the builder session is in phase ${actual}`);
  }
}

function requireApproval(input: Record<string, unknown>, tool: BuilderToolName): void {
  if (input.approved !== true) throw new Error(`${tool} requires explicit approval`);
}

function isRecoverableBuilderError(message: string): boolean {
  return /is not available while|requires explicit approval/.test(message);
}

function selectedToolContracts(session: Awaited<ReturnType<typeof requireWorkflowBuilderSession>>) {
  const selected = new Set(session.buildContract?.requirements
    .filter((entry) => entry.kind === "connector" && entry.status === "resolved")
    .flatMap((entry) => {
      const value = entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)
        ? entry.value as Record<string, unknown>
        : {};
      return Array.isArray(value.selections) ? value.selections.flatMap((selection) => {
        const record = selection && typeof selection === "object" && !Array.isArray(selection)
          ? selection as Record<string, unknown>
          : {};
        return Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String) : [];
      }) : [];
    }) ?? []);
  if (selected.size === 0) return session.discoveredToolContracts.filter((contract) => contract.provider !== "composio");
  return session.discoveredToolContracts.filter((contract) =>
    contract.provider !== "composio" || selected.has(String(contract.constraints.actionSlug ?? contract.name)));
}

async function deriveUnresolvedLegacyBuildContract(
  auth: AuthContext,
  session: Awaited<ReturnType<typeof requireWorkflowBuilderSession>>,
) {
  if (session.buildContract || !session.resolvedIntent) return session.buildContract;
  const buildContract = deriveLoopBuildContract({
    intentContext: session.resolvedIntent,
    discoveredToolContracts: session.discoveredToolContracts,
  });
  await updateWorkflowBuilderSession(auth, session.id, { phase: "resolving_requirements", buildContract });
  return buildContract;
}

async function compileRuntimeSnapshotForSession(
  auth: AuthContext,
  sessionId: string,
  session: Awaited<ReturnType<typeof requireWorkflowBuilderSession>>,
) {
  if (!session.resolvedIntent) throw new Error("Resolved intent is required before compiling the runtime contract");
  const buildContract = session.buildContract ?? await deriveUnresolvedLegacyBuildContract(auth, session);
  assertBuildContractReady(buildContract);
  const snapshot = await compileEnrichedRuntimeSpecSnapshot({
    auth,
    prompt: session.goal,
    intentContext: session.resolvedIntent,
    buildContract,
    discoveredToolContracts: session.discoveredToolContracts,
  });
  await updateWorkflowBuilderSession(auth, sessionId, { error: null });
  return snapshot;
}

type BuilderTestRunResult = {
  id: string;
  workflowId: string;
  status: string;
  triggerLabel: string | null;
  error: string | null;
};

async function runSavedWorkflowTestRun(auth: AuthContext, workflowId: string): Promise<BuilderTestRunResult> {
  reportLoopBuilderProgress({
    stage: "builder_test",
    message: "Starting builder test run...",
    status: "running",
  });
  const queued = await createSpecLoopRun(auth, workflowId, {
    source: "manual",
    label: "Builder verification test",
  });
  try {
    const completed = await runSpecLoopHeadless(auth, workflowId, queued.id);
    reportLoopBuilderProgress({
      stage: "builder_test",
      message: completed.status === "succeeded"
        ? "Builder test run completed."
        : `Builder test run finished with status: ${completed.status}.`,
      status: completed.status === "failed" ? "failed" : "completed",
      details: {
        runId: completed.id,
        workflowId: completed.workflowId,
        status: completed.status,
        error: completed.error,
      },
    });
    return {
      id: completed.id,
      workflowId: completed.workflowId,
      status: completed.status,
      triggerLabel: completed.triggerLabel,
      error: completed.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportLoopBuilderProgress({
      stage: "builder_test",
      message: "Builder test run failed.",
      status: "failed",
      details: {
        runId: queued.id,
        workflowId,
        status: "failed",
        error: message,
      },
    });
    return {
      id: queued.id,
      workflowId,
      status: "failed",
      triggerLabel: queued.triggerLabel,
      error: message,
    };
  }
}

async function execute(auth: AuthContext, sessionId: string, toolName: BuilderToolName, input: Record<string, unknown>) {
  let session = await requireWorkflowBuilderSession(auth, sessionId);
  switch (toolName) {
    case "getAvailableTools": {
      requirePhase(session.phase, ["new", "analyzing", "needs_clarification", "failed"], toolName);
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "analyzing", error: null });
      const {
        outcome,
        cadence,
        approvalModel,
        toolCategories,
        runtimeInputs,
        resolvedIntent: resolvedIntentText,
        selectedToolkits,
        capabilityQueries,
        assumptions,
      } = normalizeGetAvailableToolsInput(input, session.goal);
      if (!resolvedIntentText) throw new Error("getAvailableTools requires a normalized resolved intent");
      if (selectedToolkits.length === 0) throw new Error("Select at least one app before discovering tools");
      const analysis = loopIntentAnalysisSchema.parse({
        normalizedIntent: {
          outcome,
          toolCategories,
          cadence,
          approvalModel,
          runtimeInputs,
        },
        questions: [],
        assumptions,
        connectorFeasibility: [],
        interactivePrompts: [],
        events: [],
        analyzedAt: new Date().toISOString(),
      });
      const resolvedIntent = loopIntentContextSchema.parse({
        analysis,
        decisions: [],
        assumptions: analysis.assumptions,
        resolvedIntent: resolvedIntentText,
        resolvedAt: new Date().toISOString(),
      });
      const discovered = await discoverToolsForLoopBuild({
        auth,
        prompt: resolvedIntentText,
        selectedToolkits,
        capabilityQueries,
        toolCategories,
        composioSessionId: session.composioSessionId,
        limit: 24,
      });
      const discoveredTriggers = await listComposioTriggerTypes(selectedToolkits).catch(() => []);
      if (discovered.sessionId != null && discovered.sessionId !== session.composioSessionId) {
        throw new Error("Composio discovery did not reuse the persisted builder session");
      }
      const contracts = normalizeDiscoveredToolContracts(discovered.tools.map((entry) => ({
        ...entry.contract,
        constraints: { ...entry.contract.constraints, connected: entry.connected },
      })));
      const buildContract = deriveLoopBuildContract({
        intentContext: resolvedIntent,
        discoveredToolContracts: contracts,
        discoveredTriggers,
      });
      await updateWorkflowBuilderSession(auth, sessionId, {
        phase: "resolving_requirements",
        intentAnalysis: analysis,
        resolvedIntent,
        discoveredToolContracts: contracts,
        buildContract,
      });
      return {
        intentAnalysis: analysis,
        intentContext: resolvedIntent,
        composioSessionId: discovered.sessionId,
        tools: discovered.tools.map((entry) => ({
          name: entry.contract.name,
          description: entry.contract.description,
          connected: entry.connected,
          risk: entry.contract.constraints.risk ?? null,
        })),
        buildContract,
        unresolvedRequirements: unresolvedBuildRequirements(buildContract),
      };
    }
    case "resolveBuildRequirement": {
      requirePhase(session.phase, ["resolving_requirements", "intent_resolved", "failed"], toolName);
      if (!session.buildContract) throw new Error("The builder session has no build contract.");
      let discoveredToolContracts = session.discoveredToolContracts;
      const target = session.buildContract.requirements.find((entry) => entry.id === String(input.requirementId ?? ""));
      if (target?.kind === "connector" && session.resolvedIntent) {
        await refreshBuilderConnectorAvailability(auth, sessionId);
        session = await requireWorkflowBuilderSession(auth, sessionId);
        discoveredToolContracts = session.discoveredToolContracts;
      }
      if (!session.buildContract) throw new Error("The builder session has no build contract.");
      const buildContract = resolveBuildRequirement({
        contract: session.buildContract,
        requirementId: String(input.requirementId ?? ""),
        value: input.value,
        discoveredToolContracts,
      });
      const unresolvedRequirements = unresolvedBuildRequirements(buildContract);
      await updateWorkflowBuilderSession(auth, sessionId, {
        phase: phaseAfterRequirementsResolved(session.phase, unresolvedRequirements.length),
        buildContract,
        discoveredToolContracts,
        error: null,
      });
      return {
        buildContract,
        unresolvedRequirements,
        readyForSpecDraft: unresolvedRequirements.length === 0,
      };
    }
    case "refreshConnectorAvailability": {
      requirePhase(session.phase, ["resolving_requirements", "intent_resolved", "failed"], toolName);
      return { checklist: await refreshBuilderConnectorAvailability(auth, sessionId) };
    }
    case "saveLoop": {
      const preview = input.preview === true;
      if (!preview) requireApproval(input, toolName);
      requirePhase(session.phase, ["intent_resolved", "saved", "failed"], toolName);

      if (preview) {
        return { spec: await compileRuntimeSnapshotForSession(auth, sessionId, session), preview: true };
      }

      if (session.phase === "saved" && session.workflowId) {
        const buildContract = session.buildContract ?? await deriveUnresolvedLegacyBuildContract(auth, session);
        if (!buildContract) throw new Error("Builder session is missing a build contract.");
        const spec = await compileEnrichedRuntimeSpecSnapshot({
          auth,
          prompt: session.goal,
          intentContext: session.resolvedIntent ?? undefined,
          buildContract,
          discoveredToolContracts: session.discoveredToolContracts,
        });
        const verification = await getWorkflowVerification(auth, session.workflowId);
        return {
          workflowId: session.workflowId,
          loop: { id: session.workflowId },
          verification,
          spec,
        };
      }

      await updateWorkflowBuilderSession(auth, sessionId, { error: null });
      session = await requireWorkflowBuilderSession(auth, sessionId);
      if (!session.resolvedIntent) throw new Error("Resolved intent is required before saving");
      const buildContract = session.buildContract ?? await deriveUnresolvedLegacyBuildContract(auth, session);
      assertBuildContractReady(buildContract);
      const snapshot = await compileEnrichedRuntimeSpecSnapshot({
        auth,
        prompt: session.goal,
        intentContext: session.resolvedIntent,
        buildContract,
        discoveredToolContracts: session.discoveredToolContracts,
      });
      const scheduleRequirement = buildContract.requirements.find((entry) => entry.kind === "trigger_schedule");
      const scheduleValue = scheduleRequirement?.value && typeof scheduleRequirement.value === "object" && !Array.isArray(scheduleRequirement.value)
        ? scheduleRequirement.value as Record<string, unknown>
        : {};
      const eventDriven = scheduleValue.trigger === "event";
      const approvedCron = eventDriven ? "0 9 * * *" : String(scheduleValue.cron ?? "0 9 * * 1");
      const approvedTimezone = eventDriven ? "UTC" : String(scheduleValue.timezone ?? "UTC");
      const loop = await saveLoopFromSpec({
        auth,
        specSnapshot: snapshot,
        discoveredToolContracts: selectedToolContracts(session),
        buildContract,
        cron: approvedCron,
        timezone: approvedTimezone,
        workspaceId: input.workspaceId as string | null | undefined,
        builderSessionId: session.id,
        initialStatus: "verifying",
      });
      const workflowId = String((loop as { id?: unknown }).id ?? "");
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "saved", workflowId, error: null });
      const verification = await initializeWorkflowVerification(auth, workflowId);
      void runWorkflowVerification(auth, workflowId).catch((error) => {
        console.error("[saveLoop] background verification failed:", error instanceof Error ? error.message : String(error));
      });
      return { loop, verification, workflowId, spec: snapshot };
    }
    case "runBuilderTest": {
      requirePhase(session.phase, ["saved", "failed"], toolName);
      if (!session.workflowId) throw new Error("Session has no saved workflow.");
      const testRun = await runSavedWorkflowTestRun(auth, session.workflowId);
      return { workflowId: session.workflowId, testRun };
    }
    case "runVerification": {
      if (!session.workflowId) {
        requirePhase(session.phase, ["saved"], toolName);
        throw new Error("Session has no saved workflow.");
      }
      return { verification: await runWorkflowVerification(auth, session.workflowId) };
    }
    case "confirmActivation": {
      requireApproval(input, toolName);
      requirePhase(session.phase, ["saved", "failed"], toolName);
      if (!session.workflowId) throw new Error("Session has no saved workflow.");
      const verification = await confirmWorkflowVerification(auth, session.workflowId);
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "saved", error: null });
      return { verification };
    }
  }
}

async function runCommand(auth: AuthContext, commandId: string, sessionId: string, toolName: BuilderToolName, input: Record<string, unknown>) {
  await markCommandRunning(commandId);
  try {
    const events: LoopBuilderProgressEvent[] = [];
    const usage = emptyLoopBuilderUsage();
    const result = await runWithLoopBuilderProgress({
      append: (event) => {
        const next = {
          ...event,
          ...(event.details !== undefined ? { details: sanitizeLoopBuilderProgressDetails(event.details) } : {}),
          id: events.length + 1,
          at: new Date().toISOString(),
        };
        events.push(next);
        if (event.model) usage.models[event.model] = (usage.models[event.model] ?? 0) + 1;
        if (event.promptTokens != null || event.completionTokens != null) {
          usage.calls += 1;
          usage.promptTokens += event.promptTokens ?? 0;
          usage.completionTokens += event.completionTokens ?? 0;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
          usage.estimatedCostUsd = Number((usage.estimatedCostUsd + (event.estimatedCostUsd ?? 0)).toFixed(8));
        }
        void updateCommandProgress(commandId, events.slice(-100), usage);
      },
    }, () => execute(auth, sessionId, toolName, input));
    await completeCommand(commandId, result, events.slice(-100), usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failCommand(commandId, message);
    if (!isRecoverableBuilderError(message)) {
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "failed", error: { message } }).catch(() => undefined);
    }
  }
}

export async function dispatchWorkflowBuilderCommand(input: {
  auth: AuthContext;
  sessionId?: string;
  toolName: BuilderToolName;
  input: Record<string, unknown>;
}): Promise<WorkflowBuilderCommandView> {
  const session = input.sessionId
    ? await requireWorkflowBuilderSession(input.auth, input.sessionId)
    : await createWorkflowBuilderSession(input.auth, String(input.input.prompt ?? ""));
  const commandId = randomUUID();
  const row = await insertWorkflowBuilderCommand(input.auth, {
    id: commandId,
    sessionId: session.id,
    toolName: input.toolName,
    inputJson: input.input,
    usage: emptyLoopBuilderUsage(),
  });
  const previous = commandQueues.get(session.id) ?? Promise.resolve();
  const queued = previous.then(() => runCommand(input.auth, commandId, session.id, input.toolName, input.input));
  commandQueues.set(session.id, queued.finally(() => {
    if (commandQueues.get(session.id) === queued) commandQueues.delete(session.id);
  }));
  return mapCommand(row);
}

export async function getWorkflowBuilderCommand(auth: AuthContext, commandId: string): Promise<WorkflowBuilderCommandView | null> {
  const row = await findWorkflowBuilderCommandRow(auth, commandId);
  return row ? mapCommand(row) : null;
}

export async function retryFailedBuilderCommand(
  auth: AuthContext,
  sessionId: string,
  commandId?: string,
): Promise<WorkflowBuilderCommandView> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  const row = await findRetryableCommandRow(auth, sessionId, commandId);
  if (!row) throw new Error("No failed builder command is available to retry");

  if (session.phase === "failed") {
    await updateWorkflowBuilderSession(auth, sessionId, {
      phase: "intent_resolved",
      error: null,
    });
  }

  return dispatchWorkflowBuilderCommand({
    auth,
    sessionId,
    toolName: row.tool_name,
    input: row.input_json ?? {},
  });
}

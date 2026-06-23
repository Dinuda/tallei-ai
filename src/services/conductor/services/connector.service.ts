import type { AuthContext } from "../../../domain/auth/index.js";
import { z } from "zod";
import {
  resolveConnectorAvailability,
  type ConnectorAvailabilitySnapshot,
} from "../../connectors/availability.js";
import {
  composioConnectorContracts,
  normalizeDiscoveredToolContracts,
} from "../../connectors/platform-integrations.js";
import { resolveBuildRequirement, unresolvedBuildRequirements } from "../domain/build-contract.js";
import { requireWorkflowBuilderSession, updateWorkflowBuilderSession, phaseAfterRequirementsResolved } from "./session.service.js";
import {
  connectorAgentPlanSchema,
  connectorSetupStateSchema,
  type ConnectorAgentPlan,
  type ConnectorOperation,
  type ConnectorSetupState,
  type ConnectorSubAgent,
} from "../contracts/connector-setup.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { plannerRoleForToolContract, type ConnectorPlannerRole } from "../domain/tool-roles.js";

export type BuilderConnectorChecklist = ConnectorAvailabilitySnapshot & {
  requirementId: string;
  complete: boolean;
};

function toolkitForContract(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

function actionSlugForContract(contract: ToolContract): string {
  const slug = contract.constraints.actionSlug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : contract.name;
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "connector";
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function schemaRequiredFields(schema: unknown): string[] {
  const normalized = objectRecord(schema);
  return Array.isArray(normalized.required) ? normalized.required.map(String).filter(Boolean) : [];
}

function approvalRequired(contract: ToolContract): boolean {
  return Boolean(contract.approval?.required);
}

function approvalReason(contract: ToolContract): string | undefined {
  return typeof contract.approval?.reason === "string" && contract.approval.reason.trim()
    ? contract.approval.reason
    : undefined;
}

function outputSchemaFor(contract: ToolContract): Record<string, unknown> {
  return objectRecord(contract.outputSchema);
}

function inputSchemaFor(contract: ToolContract): Record<string, unknown> {
  return objectRecord(contract.inputSchema);
}

function checklistSelectedContracts(checklist: BuilderConnectorChecklist, contracts: ToolContract[]): ToolContract[] {
  const selected = new Set(checklist.apps.flatMap((app) => app.actions.map((action) => `${app.toolkit.toLowerCase()}:${action.slug}`)));
  return contracts.filter((contract) => selected.has(`${toolkitForContract(contract)}:${actionSlugForContract(contract)}`));
}

function connectorSetupRequired(checklist: BuilderConnectorChecklist, contracts: ToolContract[]): boolean {
  const selectedContracts = checklistSelectedContracts(checklist, contracts);
  const toolkits = new Set(selectedContracts.map(toolkitForContract).filter(Boolean));
  if (toolkits.size > 1 || selectedContracts.length > 1) return true;
  return selectedContracts.some((contract) => schemaRequiredFields(inputSchemaFor(contract)).length > 0);
}

function makeOperation(contract: ToolContract, index: number, plannerRole: ConnectorPlannerRole): ConnectorOperation {
  const requiredBindings = Object.fromEntries(schemaRequiredFields(inputSchemaFor(contract)).map((field) => [
    field,
    {
      kind: "runtime_channel" as const,
      channelKey: `${slugId(actionSlugForContract(contract))}_${slugId(field)}`,
      prompt: `Provide ${field} for ${contract.name}.`,
    },
  ]));
  return {
    id: `op_${index}_${slugId(actionSlugForContract(contract))}`,
    toolRef: contract.toolRef,
    actionSlug: actionSlugForContract(contract),
    name: contract.name,
    plannerRole,
    inputBindings: requiredBindings,
    outputSchema: outputSchemaFor(contract),
    approvalPolicy: {
      required: approvalRequired(contract),
      ...(approvalReason(contract) ? { reason: approvalReason(contract) } : {}),
    },
    dependsOn: [],
  };
}

async function inferPlannerRoles(input: {
  goal: string;
  intent: string;
  checklist: BuilderConnectorChecklist;
  contracts: ToolContract[];
}): Promise<Map<string, ConnectorPlannerRole>> {
  const selectedContracts = checklistSelectedContracts(input.checklist, input.contracts);
  if (selectedContracts.length === 0) return new Map();
  if (!input.intent.trim()) {
    throw new Error("Connector setup needs a resolved intent before planner roles can be assigned.");
  }

  const next = new Map<string, ConnectorPlannerRole>();
  for (const contract of selectedContracts) {
    next.set(contract.toolRef, plannerRoleForToolContract(contract));
  }
  return next;
}

async function defaultAgentPlan(input: {
  goal: string;
  intent: string;
  checklist: BuilderConnectorChecklist;
  contracts: ToolContract[];
}): Promise<ConnectorAgentPlan> {
  const selectedContracts = checklistSelectedContracts(input.checklist, input.contracts);
  if (selectedContracts.length === 0) {
    return { parentAgents: [] };
  }
  const plannerRoles = await inferPlannerRoles(input);
  const byToolkit = new Map<string, ToolContract[]>();
  for (const contract of selectedContracts) {
    const toolkit = toolkitForContract(contract);
    byToolkit.set(toolkit, [...(byToolkit.get(toolkit) ?? []), contract]);
  }
  const parentId = "connector_parent_1";
  const subAgents: ConnectorSubAgent[] = [...byToolkit.entries()].map(([toolkit, contracts], toolkitIndex) => {
    const accountId = input.checklist.apps.find((app) => app.toolkit === toolkit)?.selectedAccountIds[0];
    return {
      id: `connector_sub_${toolkitIndex + 1}_${slugId(toolkit)}`,
      parentAgentId: parentId,
      goal: `Use ${toolkit} connector actions required for: ${input.goal}`,
      toolkit,
      ...(accountId ? { accountId } : {}),
      operations: contracts.map((contract, index) => {
        const plannerRole = plannerRoles.get(contract.toolRef);
        if (!plannerRole) {
          throw new Error(`Connector planner did not return a role for ${contract.toolRef}.`);
        }
        return makeOperation(contract, index + 1, plannerRole);
      }),
      dependsOn: [],
      handoffOutputs: [{ path: "/" }],
      testStatus: "not_run",
    };
  });
  return {
    parentAgents: [{
      id: parentId,
      name: "Connector Coordinator",
      goal: `Coordinate connected app work for: ${input.goal}`,
      toolkits: [...byToolkit.keys()],
      dependsOn: [],
      subAgents,
      successCriteria: ["Connector operations are configured, validated, and ready for workflow planning."],
      failurePolicy: "Pause and ask the operator when connector output is missing or ambiguous.",
    }],
  };
}

function selectedAccountsFromChecklist(checklist: BuilderConnectorChecklist): Record<string, string[]> {
  return Object.fromEntries(checklist.apps.map((app) => [app.toolkit, app.selectedAccountIds]));
}

function selectedActionsFromChecklist(checklist: BuilderConnectorChecklist, contracts: ToolContract[]) {
  const selectedContracts = checklistSelectedContracts(checklist, contracts);
  return selectedContracts.map((contract) => ({
    toolkit: toolkitForContract(contract),
    actionSlug: actionSlugForContract(contract),
    toolRef: contract.toolRef,
  }));
}

function hasCycle(nodes: Array<{ id: string; dependsOn: string[] }>): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function validateSetupState(state: ConnectorSetupState, contracts: ToolContract[]): string[] {
  const errors: string[] = [];
  if (state.agentPlan.parentAgents.length === 0) errors.push("At least one parent agent goal is required.");
  const operationContracts = new Map(contracts.map((contract) => [contract.toolRef, contract]));
  const subAgents = state.agentPlan.parentAgents.flatMap((parent) => {
    if (!parent.goal.trim()) errors.push(`Parent agent ${parent.id} needs a goal.`);
    return parent.subAgents;
  });
  if (hasCycle(subAgents.map((subAgent) => ({ id: subAgent.id, dependsOn: subAgent.dependsOn })))) {
    errors.push("Connector sub-agent dependencies cannot contain a cycle.");
  }
  for (const subAgent of subAgents) {
    if (!subAgent.goal.trim()) errors.push(`Sub-agent ${subAgent.id} needs a goal.`);
    if (subAgent.operations.length === 0) errors.push(`Sub-agent ${subAgent.id} needs at least one operation.`);
    for (const operation of subAgent.operations) {
      const contract = operationContracts.get(operation.toolRef);
      if (!contract) {
        errors.push(`Operation ${operation.id} references an unavailable connector action.`);
        continue;
      }
      const expectedRole = plannerRoleForToolContract(contract);
      if (operation.plannerRole !== expectedRole) {
        errors.push(`Operation ${operation.id} must use planner role "${expectedRole}" for ${contract.name}.`);
      }
      for (const field of schemaRequiredFields(inputSchemaFor(contract))) {
        if (!operation.inputBindings[field]) errors.push(`Operation ${operation.id} is missing required input binding: ${field}.`);
      }
    }
  }
  return errors;
}

function connectorResolveValueFromSetup(checklist: BuilderConnectorChecklist, setup: ConnectorSetupState) {
  return {
    selections: checklist.apps.map((app) => ({
      toolkit: app.toolkit,
      accounts: app.accounts
        .filter((account) => app.selectedAccountIds.includes(account.id))
        .map((account) => ({ id: account.id })),
      actionSlugs: app.actions.map((action) => action.slug),
    })),
    agentPlan: setup.agentPlan,
    testRun: setup.testRun,
    warnings: setup.warnings,
  };
}

function selectedAccountIdsByToolkit(session: Awaited<ReturnType<typeof requireWorkflowBuilderSession>>): Record<string, string[]> {
  const requirement = session.buildContract?.requirements.find((entry) => entry.kind === "connector");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const selections = Array.isArray(value.selections) ? value.selections : [];
  return Object.fromEntries(selections.map((selection) => {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    const accounts = Array.isArray(record.accounts) ? record.accounts : [];
    return [String(record.toolkit ?? ""), accounts.flatMap((account) => {
      const accountRecord = account && typeof account === "object" && !Array.isArray(account)
        ? account as Record<string, unknown>
        : {};
      return typeof accountRecord.id === "string" ? [accountRecord.id] : [];
    })];
  }).filter(([toolkit]) => toolkit));
}

export async function refreshBuilderConnectorAvailability(
  auth: AuthContext,
  sessionId: string,
): Promise<BuilderConnectorChecklist> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  const requirement = session.buildContract?.requirements.find((entry) => entry.kind === "connector");
  if (!requirement || !session.buildContract) throw new Error("This builder session has no connector requirement.");
  const normalizedContracts = normalizeDiscoveredToolContracts(session.discoveredToolContracts);
  const composioContracts = composioConnectorContracts(normalizedContracts);

  if (composioContracts.length === 0) {
    const now = new Date().toISOString();
    const buildContract = {
      ...session.buildContract,
      requirements: session.buildContract.requirements.map((entry) => entry.id === requirement.id
        ? {
          ...entry,
          status: "resolved" as const,
          value: { selections: [] },
          provenance: { source: "legacy" as const, resolvedAt: now },
          validationErrors: [],
          warnings: ["No third-party app connections are required for this loop."],
        }
        : entry),
      updatedAt: now,
    };
    await updateWorkflowBuilderSession(auth, sessionId, {
      discoveredToolContracts: normalizedContracts,
      buildContract,
      error: null,
    });
    return {
      checkedAt: now,
      composioSessionId: session.composioSessionId ?? "",
      apps: [],
      requirementId: requirement.id,
      complete: true,
    };
  }

  const refreshed = await resolveConnectorAvailability({
    auth,
    contracts: normalizedContracts,
    previousComposioSessionId: session.composioSessionId,
    selectedAccountIdsByToolkit: selectedAccountIdsByToolkit(session),
  });
  await updateWorkflowBuilderSession(auth, sessionId, {
    composioSessionId: refreshed.snapshot.composioSessionId,
    discoveredToolContracts: refreshed.contracts,
    error: null,
  });
  return {
    ...refreshed.snapshot,
    requirementId: requirement.id,
    complete: refreshed.snapshot.apps.length > 0
      && refreshed.snapshot.apps.every((app) =>
        app.selectedAccountIds.length > 0
        && app.selectedAccountIds.every((id) => app.accounts.some((account) =>
          account.id === id && account.status === "connected"))),
  };
}

export async function resolveBuilderConnectorRequirement(
  auth: AuthContext,
  sessionId: string,
): Promise<{ checklist: BuilderConnectorChecklist; readyForSpecDraft: boolean }> {
  const checklist = await refreshBuilderConnectorAvailability(auth, sessionId);
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.buildContract) throw new Error("This builder session has no build contract.");

  if (checklist.complete && checklist.apps.length === 0) {
    const unresolved = unresolvedBuildRequirements(session.buildContract);
    await updateWorkflowBuilderSession(auth, sessionId, {
      phase: phaseAfterRequirementsResolved(session.phase, unresolved.length),
      error: null,
    });
    return { checklist, readyForSpecDraft: unresolved.length === 0 };
  }

  if (!checklist.complete) {
    const pending = checklist.apps.filter((app) => !app.accountConnected);
    throw new Error(`Required apps are not connected: ${pending.map((app) => app.name).join(", ")}`);
  }
  if (connectorSetupRequired(checklist, session.discoveredToolContracts)) {
    const setup = session.connectorSetup;
    if (!setup || setup.requirementId !== checklist.requirementId || setup.stage !== "complete") {
      throw new Error("Connector agent setup is required before this connector requirement can be resolved.");
    }
    const setupErrors = validateSetupState(setup, session.discoveredToolContracts);
    if (setupErrors.length > 0) throw new Error(setupErrors.join(" "));
    if (setup.testRun?.status !== "passed" && setup.testRun?.status !== "skipped" && setup.testRun?.status !== "unavailable") {
      throw new Error("Connector agent setup must be tested or explicitly skipped before resolving.");
    }
    const value = connectorResolveValueFromSetup(checklist, setup);
    const buildContract = resolveBuildRequirement({
      contract: session.buildContract,
      requirementId: checklist.requirementId,
      value,
      discoveredToolContracts: session.discoveredToolContracts,
    });
    const unresolved = unresolvedBuildRequirements(buildContract);
    await updateWorkflowBuilderSession(auth, sessionId, {
      phase: phaseAfterRequirementsResolved(session.phase, unresolved.length),
      buildContract,
      error: null,
    });
    return { checklist, readyForSpecDraft: unresolved.length === 0 };
  }
  const value = {
    selections: checklist.apps.map((app) => ({
      toolkit: app.toolkit,
      accounts: app.accounts
        .filter((account) => app.selectedAccountIds.includes(account.id))
        .map((account) => ({ id: account.id })),
      actionSlugs: app.actions.map((action) => action.slug),
    })),
  };
  const buildContract = resolveBuildRequirement({
    contract: session.buildContract,
    requirementId: checklist.requirementId,
    value,
    discoveredToolContracts: session.discoveredToolContracts,
  });
  const unresolved = unresolvedBuildRequirements(buildContract);
  await updateWorkflowBuilderSession(auth, sessionId, {
    phase: phaseAfterRequirementsResolved(session.phase, unresolved.length),
    buildContract,
    error: null,
  });
  return { checklist, readyForSpecDraft: unresolved.length === 0 };
}

export async function startBuilderConnectorSetup(
  auth: AuthContext,
  sessionId: string,
): Promise<{ checklist: BuilderConnectorChecklist; setup: ConnectorSetupState; setupRequired: boolean }> {
  const checklist = await refreshBuilderConnectorAvailability(auth, sessionId);
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  const now = new Date().toISOString();
  const setupRequired = checklist.complete && connectorSetupRequired(checklist, session.discoveredToolContracts);
  const existing = session.connectorSetup?.requirementId === checklist.requirementId ? session.connectorSetup : null;
  const setup = existing ?? connectorSetupStateSchema.parse({
    version: "v1",
    requirementId: checklist.requirementId,
    stage: checklist.complete ? "goals" : "auth",
    selectedAccounts: selectedAccountsFromChecklist(checklist),
    selectedActions: selectedActionsFromChecklist(checklist, session.discoveredToolContracts),
    agentPlan: await defaultAgentPlan({
      goal: session.goal,
      intent: session.resolvedIntent?.resolvedIntent ?? session.goal,
      checklist,
      contracts: session.discoveredToolContracts,
    }),
    warnings: [],
    updatedAt: now,
  });
  const refreshedSetup = connectorSetupStateSchema.parse({
    ...setup,
    stage: checklist.complete && setup.stage === "auth" ? "goals" : setup.stage,
    selectedAccounts: selectedAccountsFromChecklist(checklist),
    selectedActions: selectedActionsFromChecklist(checklist, session.discoveredToolContracts),
    updatedAt: now,
  });
  await updateWorkflowBuilderSession(auth, sessionId, { connectorSetup: refreshedSetup, error: null });
  return { checklist, setup: refreshedSetup, setupRequired };
}

export async function getBuilderConnectorSetup(
  auth: AuthContext,
  sessionId: string,
): Promise<{ checklist: BuilderConnectorChecklist; setup: ConnectorSetupState | null; setupRequired: boolean }> {
  const checklist = await refreshBuilderConnectorAvailability(auth, sessionId);
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  return {
    checklist,
    setup: session.connectorSetup,
    setupRequired: checklist.complete && connectorSetupRequired(checklist, session.discoveredToolContracts),
  };
}

export async function updateBuilderConnectorSetupGoals(
  auth: AuthContext,
  sessionId: string,
  agentPlan: ConnectorAgentPlan,
): Promise<{ setup: ConnectorSetupState; errors: string[] }> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.connectorSetup) throw new Error("Connector setup has not been started.");
  const setup = connectorSetupStateSchema.parse({
    ...session.connectorSetup,
    stage: "graph",
    agentPlan: connectorAgentPlanSchema.parse(agentPlan),
    testRun: undefined,
    updatedAt: new Date().toISOString(),
  });
  const errors = validateSetupState(setup, session.discoveredToolContracts);
  await updateWorkflowBuilderSession(auth, sessionId, { connectorSetup: setup, error: null });
  return { setup, errors };
}

export async function updateBuilderConnectorSetupGraph(
  auth: AuthContext,
  sessionId: string,
  agentPlan: ConnectorAgentPlan,
): Promise<{ setup: ConnectorSetupState; errors: string[] }> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.connectorSetup) throw new Error("Connector setup has not been started.");
  const setup = connectorSetupStateSchema.parse({
    ...session.connectorSetup,
    stage: "test",
    agentPlan: connectorAgentPlanSchema.parse(agentPlan),
    testRun: undefined,
    updatedAt: new Date().toISOString(),
  });
  const errors = validateSetupState(setup, session.discoveredToolContracts);
  await updateWorkflowBuilderSession(auth, sessionId, { connectorSetup: setup, error: null });
  return { setup, errors };
}

export async function testBuilderConnectorSetup(
  auth: AuthContext,
  sessionId: string,
  input: { skip?: boolean } = {},
): Promise<{ setup: ConnectorSetupState; errors: string[] }> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.connectorSetup) throw new Error("Connector setup has not been started.");
  const errors = validateSetupState(session.connectorSetup, session.discoveredToolContracts);
  const now = new Date().toISOString();
  const status = input.skip ? "skipped" : errors.length > 0 ? "failed" : "unavailable";
  const warnings = input.skip
    ? [...session.connectorSetup.warnings.filter((warning) => warning !== "Connector test was skipped by the user."), "Connector test was skipped by the user."]
    : session.connectorSetup.warnings;
  const setup = connectorSetupStateSchema.parse({
    ...session.connectorSetup,
    stage: "test",
    testRun: { status, checkedAt: now, errors },
    warnings,
    updatedAt: now,
  });
  await updateWorkflowBuilderSession(auth, sessionId, { connectorSetup: setup, error: null });
  return { setup, errors };
}

export async function commitBuilderConnectorSetup(
  auth: AuthContext,
  sessionId: string,
): Promise<{ checklist: BuilderConnectorChecklist; setup: ConnectorSetupState; readyForSpecDraft: boolean }> {
  const checklist = await refreshBuilderConnectorAvailability(auth, sessionId);
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.buildContract) throw new Error("This builder session has no build contract.");
  if (!session.connectorSetup) throw new Error("Connector setup has not been started.");
  if (!checklist.complete) throw new Error("Required apps are not connected.");
  const errors = validateSetupState(session.connectorSetup, session.discoveredToolContracts);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const testStatus = session.connectorSetup.testRun?.status;
  if (testStatus !== "passed" && testStatus !== "skipped" && testStatus !== "unavailable") {
    throw new Error("Connector agent setup must be tested or explicitly skipped before commit.");
  }
  const setup = connectorSetupStateSchema.parse({
    ...session.connectorSetup,
    stage: "complete",
    updatedAt: new Date().toISOString(),
  });
  const buildContract = resolveBuildRequirement({
    contract: session.buildContract,
    requirementId: setup.requirementId,
    value: connectorResolveValueFromSetup(checklist, setup),
    discoveredToolContracts: session.discoveredToolContracts,
  });
  const unresolved = unresolvedBuildRequirements(buildContract);
  await updateWorkflowBuilderSession(auth, sessionId, {
    phase: phaseAfterRequirementsResolved(session.phase, unresolved.length),
    buildContract,
    connectorSetup: setup,
    error: null,
  });
  return { checklist, setup, readyForSpecDraft: unresolved.length === 0 };
}

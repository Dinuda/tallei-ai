import type { AuthContext } from "../../domain/auth/index.js";
import {
  resolveConnectorAvailability,
  type ConnectorAvailabilitySnapshot,
} from "../connectors/availability.js";
import { resolveBuildRequirement, unresolvedBuildRequirements } from "../loop-engine/build-contract.js";
import { requireWorkflowBuilderSession, updateWorkflowBuilderSession } from "./sessions.js";

export type BuilderConnectorChecklist = ConnectorAvailabilitySnapshot & {
  requirementId: string;
  complete: boolean;
};

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
  const refreshed = await resolveConnectorAvailability({
    auth,
    contracts: session.discoveredToolContracts,
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
  if (!checklist.complete) {
    const pending = checklist.apps.filter((app) => !app.accountConnected);
    throw new Error(`Required apps are not connected: ${pending.map((app) => app.name).join(", ")}`);
  }
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.buildContract) throw new Error("This builder session has no build contract.");
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
    phase: unresolved.length === 0 ? "intent_resolved" : "resolving_requirements",
    buildContract,
    error: null,
  });
  return { checklist, readyForSpecDraft: unresolved.length === 0 };
}

import type { AuthContext } from "../../../domain/auth/index.js";
import {
  resolveBuildRequirement,
  slimUnresolvedRequirements,
} from "../domain/build-contract.js";
import { requireWorkflowBuilderSession, updateWorkflowBuilderSession } from "./session.service.js";

export async function saveBuilderArtifactBundle(
  auth: AuthContext,
  sessionId: string,
  input: { requirementId: string; value: unknown },
) {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.buildContract) throw new Error("This builder session has no build contract.");

  const rawValue = input.value && typeof input.value === "object" && !Array.isArray(input.value)
    ? input.value as Record<string, unknown>
    : {};
  let artifactBundleJson: unknown | null = session.artifactBundleJson;
  let requirementValue = input.value;

  if (rawValue.mode === "supplied_template" && typeof rawValue.template === "string") {
    artifactBundleJson = JSON.parse(rawValue.template);
    requirementValue = { mode: "supplied_template", bundleRef: sessionId };
  }

  const buildContract = resolveBuildRequirement({
    contract: session.buildContract,
    requirementId: input.requirementId,
    value: requirementValue,
    discoveredToolContracts: session.discoveredToolContracts,
  });
  const unresolvedRequirements = slimUnresolvedRequirements(buildContract);
  await updateWorkflowBuilderSession(auth, sessionId, {
    buildContract,
    artifactBundleJson,
    error: null,
  });
  return {
    resolvedRequirementId: input.requirementId,
    readyForSpecDraft: unresolvedRequirements.length === 0,
    unresolvedRequirements,
  };
}

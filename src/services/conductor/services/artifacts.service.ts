import type { AuthContext } from "../../../domain/auth/index.js";
import { resolveBuildRequirement, unresolvedBuildRequirements } from "../domain/build-contract.js";
import { requireWorkflowBuilderSession, updateWorkflowBuilderSession } from "./session.service.js";

export async function saveBuilderArtifactBundle(
  auth: AuthContext,
  sessionId: string,
  input: { requirementId: string; value: unknown },
) {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  if (!session.buildContract) throw new Error("This builder session has no build contract.");
  const buildContract = resolveBuildRequirement({
    contract: session.buildContract,
    requirementId: input.requirementId,
    value: input.value,
    discoveredToolContracts: session.discoveredToolContracts,
  });
  const unresolvedRequirements = unresolvedBuildRequirements(buildContract);
  await updateWorkflowBuilderSession(auth, sessionId, {
    buildContract,
    error: null,
  });
  return { buildContract, unresolvedRequirements };
}

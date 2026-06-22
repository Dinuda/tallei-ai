import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { createLoopFromDefinition } from "../loop-executor/creator.js";
import { noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
import { selectedArtifactContract } from "../loop-engine/build-contract.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { LoopBuildContract } from "../loop-engine/build-contract.js";
import { definitionFromApprovedSpec } from "../loop-runtime/spec-run-types.js";
import { bindLoopSpecAgentAvatars } from "./agent-persona-enrichment.js";
import { persistApprovedLoopSpecSnapshot } from "./specs.js";

export type LoopBuilderProposal = {
  title: string;
  summary: string;
  [key: string]: unknown;
};

export async function saveLoopFromSpec(input: {
  auth: AuthContext;
  specSnapshot: import("../loop-engine/spec-contracts.js").NoSlopSpecSnapshot;
  discoveredToolContracts: ToolContract[];
  buildContract: LoopBuildContract;
  cron: string;
  timezone: string;
  workspaceId?: string | null;
  builderSessionId?: string;
  initialStatus?: "active" | "verifying";
}) {
  const snapshot = noSlopSpecSnapshotSchema.parse(input.specSnapshot);
  await persistApprovedLoopSpecSnapshot(input.auth, snapshot);
  await bindLoopSpecAgentAvatars(input.auth, snapshot);
  const buildContract = input.buildContract;
  const cron = normalizeDesignCron(input.cron, snapshot.specJson.purpose);
  const artifacts = selectedArtifactContract(buildContract);
  const resolvedWorkspaceId = input.workspaceId ?? input.auth.workspaceId ?? null;
  const definition = definitionFromApprovedSpec({
    snapshot,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts,
    ...(artifacts ? { artifacts } : {}),
    cron,
    timezone: input.timezone,
    workspaceId: resolvedWorkspaceId,
    ...(input.builderSessionId ? { builderSessionId: input.builderSessionId } : {}),
  });
  const loop = await createLoopFromDefinition({
    auth: input.auth,
    definition,
    title: snapshot.title,
    workspaceId: resolvedWorkspaceId,
    initialStatus: input.initialStatus ?? "verifying",
  });
  if (input.builderSessionId) {
    await pool.query(
      `UPDATE workflow_builder_sessions
       SET workflow_id = $4, spec_id = $5, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [input.builderSessionId, input.auth.tenantId, input.auth.userId, loop.id, snapshot.id],
    );
  }
  return loop;
}

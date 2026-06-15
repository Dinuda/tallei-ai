import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { resolveConnectorAvailability } from "../connectors/availability.js";
import { executeApprovedComposioAction, registerComposioTrigger } from "../connectors/composio.js";
import type { ToolContract } from "../tool-spec/types.js";
import {
  assertBuildContractReady,
  selectedConnectorAccountId,
  selectedConnectorAccountIds,
  selectedLoopTrigger,
  type LoopBuildContract,
} from "../loop-engine/build-contract.js";
import {
  resolveConnectorOutputForValidation,
  validateConnectorActionOutput,
} from "../loop-runtime/connector-action-payload.js";
import { nextCronRunAt } from "./cron.js";
import { loopDefinitionSchema } from "./types.js";

export type WorkflowVerificationStatus = "pending" | "running" | "awaiting_confirmation" | "failed" | "confirmed";
export type WorkflowVerificationEvidence = {
  toolRef: string;
  level: "executable_read" | "action_visibility";
  ok: boolean;
  detail: string;
};

export type WorkflowVerificationView = {
  id: string;
  workflowId: string;
  status: WorkflowVerificationStatus;
  evidence: WorkflowVerificationEvidence[];
  failures: string[];
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type VerificationRow = {
  id: string;
  workflow_id: string;
  status: WorkflowVerificationStatus;
  evidence_json: WorkflowVerificationEvidence[];
  failures_json: string[];
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: VerificationRow): WorkflowVerificationView {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    evidence: row.evidence_json ?? [],
    failures: row.failures_json ?? [],
    confirmedAt: iso(row.confirmed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export async function initializeWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView> {
  const result = await pool.query<VerificationRow>(
    `INSERT INTO workflow_verification_runs (workflow_id, tenant_id, user_id)
     VALUES ($1, $2, $3)
     RETURNING id, workflow_id, status, evidence_json, failures_json, confirmed_at, created_at, updated_at`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return mapRow(result.rows[0]!);
}

export async function getWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView | null> {
  const result = await pool.query<VerificationRow>(
    `SELECT id, workflow_id, status, evidence_json, failures_json, confirmed_at, created_at, updated_at
     FROM workflow_verification_runs
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

function toolkitFor(contract: ToolContract): string {
  const value = contract.constraints.toolkit;
  if (typeof value === "string" && value.trim()) return value.trim();
  return contract.toolRef.match(/^composio\.([^.]+)\./i)?.[1] ?? "";
}

function hasNoRequiredInputs(contract: ToolContract): boolean {
  const required = contract.inputSchema.required;
  return !Array.isArray(required) || required.length === 0;
}

export async function runWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView> {
  const workflow = await pool.query<{ status: string; metadata_json: unknown }>(
    `SELECT status, metadata_json FROM workflows WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  if (workflow.rows[0]?.status !== "verifying") throw new Error("Only verifying workflows can run verification.");
  let verification = await getWorkflowVerification(auth, workflowId);
  if (!verification) throw new Error("Workflow verification not found.");
  if (verification.status !== "pending") {
    verification = await initializeWorkflowVerification(auth, workflowId);
  }
  let definitionFailure: string | null = null;
  let workflowBuildContract: LoopBuildContract | null = null;
  try {
    const metadata = workflow.rows[0].metadata_json && typeof workflow.rows[0].metadata_json === "object" && !Array.isArray(workflow.rows[0].metadata_json)
      ? workflow.rows[0].metadata_json as Record<string, unknown>
      : {};
    const definition = loopDefinitionSchema.parse(metadata.loopDefinition);
    assertBuildContractReady(definition.buildContract);
    workflowBuildContract = definition.buildContract;
  } catch (error) {
    definitionFailure = `Workflow build contract verification failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const sessionResult = await pool.query<{
    discovered_tool_contracts_json: ToolContract[];
    build_contract_json: LoopBuildContract | null;
    composio_session_id: string | null;
  }>(
    `SELECT discovered_tool_contracts_json, build_contract_json, composio_session_id
     FROM workflow_builder_sessions
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY updated_at DESC LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const session = sessionResult.rows[0];
  const selected = new Set(session?.build_contract_json?.requirements
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
  let visibilityFailure: string | null = null;
  let refreshedContracts = session?.discovered_tool_contracts_json ?? [];
  if (selected.size > 0 && session) {
    try {
      const refreshed = await resolveConnectorAvailability({
        auth,
        contracts: refreshedContracts,
        previousComposioSessionId: session.composio_session_id,
        selectedAccountIdsByToolkit: Object.fromEntries(
          [...new Set(refreshedContracts.map(toolkitFor))]
            .map((toolkit) => [toolkit, selectedConnectorAccountIds(workflowBuildContract, toolkit)]),
        ),
      });
      refreshedContracts = refreshed.contracts;
      await pool.query(
        `UPDATE workflow_builder_sessions
         SET composio_session_id = $4, discovered_tool_contracts_json = $5::jsonb, updated_at = NOW()
         WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3`,
        [workflowId, auth.tenantId, auth.userId, refreshed.snapshot.composioSessionId, JSON.stringify(refreshed.contracts)],
      );
    } catch (error) {
      visibilityFailure = `Connector visibility check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (selected.size > 0) {
    visibilityFailure = "Connector visibility check failed: the workflow has no correlated builder session.";
  }
  const contracts: ToolContract[] = refreshedContracts
    .filter((contract) => contract.provider !== "composio" || selected.has(String(contract.constraints.actionSlug ?? contract.name)))
    .map((contract): ToolContract => contract);
  await pool.query(`UPDATE workflow_verification_runs SET status = 'running', updated_at = NOW() WHERE id = $1`, [verification.id]);

  const evidence: WorkflowVerificationEvidence[] = [];
  const failures: string[] = [definitionFailure, visibilityFailure].filter((value): value is string => Boolean(value));
  if (contracts.length === 0) {
    evidence.push({
      toolRef: "internal.workflow_contract",
      level: "action_visibility",
      ok: true,
      detail: "This workflow has no external connector actions. Its approved build contract and runtime definition are present.",
    });
  }
  for (const contract of contracts) {
    if (contract.constraints.connected !== true) {
      failures.push(`${contract.name}: connector account is not connected.`);
      continue;
    }
    if (contract.provider === "composio" && contract.constraints.actionVisible !== true) {
      failures.push(`${contract.name}: connector action visibility could not be confirmed.`);
      continue;
    }
    if (contract.effect !== "read_external" || !hasNoRequiredInputs(contract)) {
      evidence.push({
        toolRef: contract.toolRef,
        level: "action_visibility",
        ok: true,
        detail: "The connected account exposes the required action and exact contract. No safe zero-input read probe is available.",
      });
      continue;
    }
    try {
      const result = await executeApprovedComposioAction({
        auth,
        toolkit: toolkitFor(contract),
        actionSlug: String(contract.constraints.actionSlug ?? contract.name),
        connectorAccountId: selectedConnectorAccountId(workflowBuildContract, toolkitFor(contract)),
        payload: {},
        idempotencyKey: `verification:${verification.id}:${contract.toolRef}`,
      });
      if (!result.ok) throw new Error(result.error ?? "Connector read probe reported failure.");
      const validation = validateConnectorActionOutput(
        contract,
        resolveConnectorOutputForValidation(contract, result),
      );
      if (!validation.valid) {
        throw new Error(`Output schema mismatch: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
      }
      evidence.push({ toolRef: contract.toolRef, level: "executable_read", ok: true, detail: "A non-destructive read probe succeeded and matched the exact output schema." });
    } catch (error) {
      failures.push(`${contract.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const status: WorkflowVerificationStatus = failures.length > 0 ? "failed" : "awaiting_confirmation";
  const result = await pool.query<VerificationRow>(
    `UPDATE workflow_verification_runs
     SET status = $2, evidence_json = $3::jsonb, failures_json = $4::jsonb, updated_at = NOW()
     WHERE id = $1
     RETURNING id, workflow_id, status, evidence_json, failures_json, confirmed_at, created_at, updated_at`,
    [verification.id, status, JSON.stringify(evidence), JSON.stringify(failures)],
  );
  return mapRow(result.rows[0]!);
}

export async function confirmWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView> {
  const verification = await getWorkflowVerification(auth, workflowId);
  if (!verification || verification.status !== "awaiting_confirmation") {
    throw new Error("Successful verification evidence must be awaiting confirmation before activation.");
  }
  const workflowSnapshot = await pool.query<{ schedule_rrule: string; metadata_json: unknown }>(
    `SELECT schedule_rrule, metadata_json FROM workflows
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'verifying'
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const snapshot = workflowSnapshot.rows[0];
  if (!snapshot) throw new Error("Workflow is not awaiting verification.");
  const metadata = snapshot.metadata_json && typeof snapshot.metadata_json === "object" && !Array.isArray(snapshot.metadata_json)
    ? snapshot.metadata_json as Record<string, unknown>
    : {};
  const definition = loopDefinitionSchema.parse(metadata.loopDefinition);
  const selectedTrigger = definition.buildContract ? selectedLoopTrigger(definition.buildContract) : null;
  const registeredTrigger = selectedTrigger?.mode === "event"
    ? await registerComposioTrigger({ auth, toolkit: selectedTrigger.toolkit, triggerSlug: selectedTrigger.triggerSlug })
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await client.query<{ schedule_rrule: string }>(
      `SELECT schedule_rrule FROM workflows
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'verifying'
       FOR UPDATE`,
      [workflowId, auth.tenantId, auth.userId],
    );
    if (!workflow.rows[0]) throw new Error("Workflow is not awaiting verification.");
    if (registeredTrigger && selectedTrigger?.mode === "event") {
      await client.query(
        `INSERT INTO workflow_connector_triggers
         (workflow_id, tenant_id, user_id, toolkit, trigger_slug, trigger_instance_id, connected_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workflow_id) DO UPDATE SET
           toolkit = EXCLUDED.toolkit,
           trigger_slug = EXCLUDED.trigger_slug,
           trigger_instance_id = EXCLUDED.trigger_instance_id,
           connected_account_id = EXCLUDED.connected_account_id,
           status = 'active',
           updated_at = NOW()`,
        [workflowId, auth.tenantId, auth.userId, selectedTrigger.toolkit, selectedTrigger.triggerSlug, registeredTrigger.triggerId, registeredTrigger.connectedAccountId],
      );
    }
    await client.query(
      `UPDATE workflow_verification_runs
       SET status = 'confirmed', confirmed_at = NOW(), confirmed_by_user_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [verification.id, auth.userId],
    );
    const activated = await client.query(
      `UPDATE workflows
       SET status = 'active', next_run_at = $4::timestamptz, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'verifying'`,
      [workflowId, auth.tenantId, auth.userId, selectedTrigger?.mode === "event" ? null : nextCronRunAt(workflow.rows[0].schedule_rrule).toISOString()],
    );
    if (!activated.rowCount) throw new Error("Workflow activation failed.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return (await getWorkflowVerification(auth, workflowId))!;
}

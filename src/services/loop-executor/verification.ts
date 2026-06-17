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
import { parseRunnableSpec, type RunnableSpec } from "../loop-runtime/spec-run-types.js";
import { scheduleTriggerLabel } from "../loop-runtime/spec-runner.js";
import { isTemporalEnabled } from "../../temporal/client.js";
import { upsertLoopSchedule } from "../../temporal/schedules.js";
import { deriveVerificationScope, deriveGroundingVerificationTargets, VERIFICATION_RUNTIME_TRANSPARENCY_NOTES, type VerificationTarget } from "./verification-scope.js";
import { createLiveVerificationSpecCache, resolveLiveVerificationContract } from "./verification-spec.js";
import {
  buildProbePayload,
  extractProbeChainState,
  summarizeProbePayload,
} from "./verification-probes.js";
import { runGroundedKnowledgeSearch, type GroundingSource } from "../grounded-knowledge-search.js";
import { loadWorkflowWorkspaceId } from "../loop-runtime/resolve-loop-run-auth.js";

export type WorkflowVerificationStatus = "pending" | "running" | "awaiting_confirmation" | "failed" | "confirmed";
export type WorkflowVerificationEvidence = {
  toolRef: string;
  level: "executable_read" | "action_visibility" | "dry_run" | "trigger_check" | "grounding_probe";
  ok: boolean;
  detail: string;
  role?: "critical" | "optional";
};

export type DryRunStep = {
  order: number;
  label: string;
  actionSlug: string;
  toolkit: string;
  role: "critical" | "optional";
  ok: boolean;
  detail: string;
  payloadSummary?: string;
};

export type WorkflowVerificationView = {
  id: string;
  workflowId: string;
  status: WorkflowVerificationStatus;
  evidence: WorkflowVerificationEvidence[];
  failures: string[];
  warnings: string[];
  dryRunLog: DryRunStep[];
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
  warnings_json?: string[];
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: VerificationRow, dryRunLog: DryRunStep[] = []): WorkflowVerificationView {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    evidence: row.evidence_json ?? [],
    failures: row.failures_json ?? [],
    warnings: row.warnings_json ?? [],
    dryRunLog,
    confirmedAt: iso(row.confirmed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export async function initializeWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView> {
  const result = await pool.query<VerificationRow>(
    `INSERT INTO workflow_verification_runs (workflow_id, tenant_id, user_id)
     VALUES ($1, $2, $3)
     RETURNING id, workflow_id, status, evidence_json, failures_json, warnings_json, confirmed_at, created_at, updated_at`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return mapRow(result.rows[0]!);
}

export async function getWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView | null> {
  const result = await pool.query<VerificationRow>(
    `SELECT id, workflow_id, status, evidence_json, failures_json, warnings_json, confirmed_at, created_at, updated_at
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

function connectorActionToolRef(toolkit: string, actionSlug: string): string {
  return `composio.${toolkit.toLowerCase()}.action.${actionSlug.replace(/-/g, "_").toUpperCase()}`;
}

function targetLabel(target: VerificationTarget, contract: ToolContract | null): string {
  return contract?.name ?? target.name ?? target.actionSlug.replace(/_/g, " ").toLowerCase();
}

async function runDryRunProbe(input: {
  auth: AuthContext;
  verificationId: string;
  target: VerificationTarget;
  contract: ToolContract;
  buildContract: LoopBuildContract;
  runnableSpec: RunnableSpec | null;
  chainState: Record<string, unknown>;
}): Promise<{ ok: boolean; detail: string; payloadSummary: string; chainPatch: Record<string, unknown> }> {
  const payload = buildProbePayload(input.contract, input.target, {
    verificationId: input.verificationId,
    runnableSpec: input.runnableSpec,
    chainState: input.chainState,
  });
  const payloadSummary = summarizeProbePayload(payload);
  const result = await executeApprovedComposioAction({
    auth: input.auth,
    toolkit: input.target.toolkit,
    actionSlug: input.target.actionSlug,
    connectorAccountId: selectedConnectorAccountId(input.buildContract, input.target.toolkit),
    payload,
    idempotencyKey: `verification:${input.verificationId}:${input.target.actionSlug}`,
  });
  if (!result.ok) {
    return {
      ok: false,
      detail: result.error ?? "Dry-run probe reported failure.",
      payloadSummary,
      chainPatch: {},
    };
  }
  const validation = validateConnectorActionOutput(
    input.contract,
    resolveConnectorOutputForValidation(input.contract, result),
  );
  if (!validation.valid) {
    return {
      ok: false,
      detail: `Output schema mismatch: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
      payloadSummary,
      chainPatch: {},
    };
  }
  const output = result.actionOutputData ?? result.output;
  return {
    ok: true,
    detail: "Dry-run probe succeeded and matched the live output schema.",
    payloadSummary,
    chainPatch: extractProbeChainState(input.target, output),
  };
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
  let runnableSpec: RunnableSpec | null = null;
  try {
    const metadata = workflow.rows[0].metadata_json && typeof workflow.rows[0].metadata_json === "object" && !Array.isArray(workflow.rows[0].metadata_json)
      ? workflow.rows[0].metadata_json as Record<string, unknown>
      : {};
    runnableSpec = parseRunnableSpec(metadata);
    if (runnableSpec) {
      workflowBuildContract = runnableSpec.buildContract
        ?? runnableSpec.noSlopSpec.buildContract
        ?? runnableSpec.noSlopSpec.specJson.buildContract
        ?? null;
      if (!workflowBuildContract) throw new Error("Runnable spec is missing build contract metadata.");
      assertBuildContractReady(workflowBuildContract);
    } else {
      throw new Error("Workflow is missing a runnable spec. Re-save from the loop builder.");
    }
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
  const buildContract = workflowBuildContract ?? session?.build_contract_json ?? null;
  const scope = buildContract
    ? [
      ...deriveVerificationScope({ runnableSpec, buildContract }),
      ...deriveGroundingVerificationTargets(buildContract),
    ]
    : [];

  let visibilityFailure: string | null = null;
  let refreshedContracts = session?.discovered_tool_contracts_json ?? [];
  if (scope.length > 0 && session && buildContract) {
    try {
      const refreshed = await resolveConnectorAvailability({
        auth,
        contracts: refreshedContracts,
        previousComposioSessionId: session.composio_session_id,
        selectedAccountIdsByToolkit: Object.fromEntries(
          [...new Set(scope.map((target) => target.toolkit))]
            .map((toolkit) => [toolkit, selectedConnectorAccountIds(buildContract, toolkit)]),
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
  } else if (scope.length > 0 && !session) {
    visibilityFailure = "Connector visibility check failed: the workflow has no correlated builder session.";
  }

  await pool.query(`UPDATE workflow_verification_runs SET status = 'running', updated_at = NOW() WHERE id = $1`, [verification.id]);

  const evidence: WorkflowVerificationEvidence[] = [];
  const failures: string[] = [definitionFailure, visibilityFailure].filter((value): value is string => Boolean(value));
  const warnings: string[] = [];
  const dryRunLog: DryRunStep[] = [];
  const liveSpecCache = createLiveVerificationSpecCache();
  const chainState: Record<string, unknown> = {};

  if (scope.length === 0) {
    evidence.push({
      toolRef: "internal.workflow_contract",
      level: "action_visibility",
      ok: true,
      detail: "This workflow has no external connector actions on the verification scope.",
    });
    dryRunLog.push({
      order: 1,
      label: "Workflow contract",
      actionSlug: "internal.workflow_contract",
      toolkit: "internal",
      role: "critical",
      ok: true,
      detail: "No scoped connector dry-run targets were required.",
    });
  }

  const sortedScope = [...scope].sort((left, right) => {
    const order = (target: VerificationTarget) => {
      if (target.probeKind === "trigger_check") return 0;
      if (target.probeKind === "grounding_probe") return 1;
      if (target.actionSlug.includes("CREATE")) return 2;
      if (target.actionSlug.includes("GET") && target.actionSlug.includes("DRAFT")) return 3;
      if (target.actionSlug.includes("SEND")) return 4;
      return 5;
    };
    return order(left) - order(right);
  });

  let stepOrder = dryRunLog.length;
  const workflowWorkspaceId = await loadWorkflowWorkspaceId(auth.tenantId, auth.userId, workflowId);
  for (const target of sortedScope) {
    stepOrder += 1;
    const toolRef = target.probeKind === "trigger_check"
      ? `composio.${target.toolkit}.trigger.${target.actionSlug}`
      : target.probeKind === "grounding_probe"
        ? `internal.grounding.${target.actionSlug}`
        : connectorActionToolRef(target.toolkit, target.actionSlug);
    const sessionContract = target.probeKind === "grounding_probe" ? null : refreshedContracts.find((contract) => {
      const slug = String(contract.constraints.actionSlug ?? contract.name).replace(/-/g, "_").toUpperCase();
      return toolkitFor(contract).toLowerCase() === target.toolkit.toLowerCase()
        && slug === target.actionSlug.replace(/-/g, "_").toUpperCase();
    });
    const connected = target.probeKind === "grounding_probe" ? true : sessionContract?.constraints.connected === true;

    if (target.probeKind === "grounding_probe") {
      const source = target.groundingSource;
      const label = target.name ?? target.actionSlug;
      const needsWorkspace = source?.type === "workspace_memory"
        || source?.type === "knowledge_base"
        || source?.type === "google_doc";
      if (!source) {
        const detail = "Grounding probe target is missing source metadata.";
        evidence.push({ toolRef, level: "grounding_probe", ok: false, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok: false,
          detail,
        });
        if (target.role === "critical") failures.push(`${label}: ${detail}`);
        else warnings.push(`${label}: ${detail} (optional)`);
        continue;
      }
      if (needsWorkspace && !workflowWorkspaceId) {
        const detail = "Loop uses workspace-scoped memory but no workspace is assigned to this workflow.";
        evidence.push({ toolRef, level: "grounding_probe", ok: false, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok: false,
          detail,
        });
        failures.push(`${label}: ${detail}`);
        continue;
      }
      try {
        const verificationAuth = workflowWorkspaceId ? { ...auth, workspaceId: workflowWorkspaceId } : auth;
        const result = await runGroundedKnowledgeSearch({
          auth: verificationAuth,
          goal: "verification probe",
          sources: [source as GroundingSource],
          workflowId,
        });
        const detail = `Grounding probe succeeded (${result.sources.length} result(s)).`;
        evidence.push({ toolRef, level: "grounding_probe", ok: true, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok: true,
          detail,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        evidence.push({ toolRef, level: "grounding_probe", ok: false, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok: false,
          detail,
        });
        const message = `${label}: ${detail}`;
        if (target.role === "critical") failures.push(message);
        else warnings.push(`${message} (optional)`);
      }
      continue;
    }

    if (target.probeKind === "trigger_check") {
      try {
        const registered = await registerComposioTrigger({
          auth,
          toolkit: target.toolkit,
          triggerSlug: target.actionSlug,
        });
        const ok = Boolean(registered?.triggerId);
        const detail = ok
          ? "Event trigger registration succeeded for verification."
          : "Event trigger registration did not return an active instance.";
        evidence.push({ toolRef, level: "trigger_check", ok, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label: target.actionSlug,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok,
          detail,
        });
        if (!ok) failures.push(`${target.actionSlug}: ${detail}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        evidence.push({ toolRef, level: "trigger_check", ok: false, detail, role: target.role });
        dryRunLog.push({
          order: stepOrder,
          label: target.actionSlug,
          actionSlug: target.actionSlug,
          toolkit: target.toolkit,
          role: target.role,
          ok: false,
          detail,
        });
        failures.push(`${target.actionSlug}: ${detail}`);
      }
      continue;
    }

    if (!connected) {
      const message = `${targetLabel(target, sessionContract ?? null)}: connector account is not connected.`;
      evidence.push({ toolRef, level: "action_visibility", ok: false, detail: message, role: target.role });
      dryRunLog.push({
        order: stepOrder,
        label: targetLabel(target, sessionContract ?? null),
        actionSlug: target.actionSlug,
        toolkit: target.toolkit,
        role: target.role,
        ok: false,
        detail: message,
      });
      if (target.role === "critical") failures.push(message);
      else warnings.push(`${message} (optional)`);
      continue;
    }

    if (target.probeKind === "visibility_only") {
      const detail = "Connected account is available; visibility confirmed without a destructive dry-run.";
      evidence.push({ toolRef, level: "action_visibility", ok: true, detail, role: target.role });
      dryRunLog.push({
        order: stepOrder,
        label: targetLabel(target, sessionContract ?? null),
        actionSlug: target.actionSlug,
        toolkit: target.toolkit,
        role: target.role,
        ok: true,
        detail,
      });
      continue;
    }

    if (!buildContract) {
      const message = `${targetLabel(target, sessionContract ?? null)}: build contract missing for dry-run.`;
      if (target.role === "critical") failures.push(message);
      else warnings.push(message);
      continue;
    }

    try {
      const liveContract = await resolveLiveVerificationContract(target, liveSpecCache);
      if (!liveContract) {
        throw new Error("Live Composio action schema could not be resolved.");
      }
      const probe = await runDryRunProbe({
        auth,
        verificationId: verification.id,
        target,
        contract: liveContract,
        buildContract,
        runnableSpec,
        chainState,
      });
      Object.assign(chainState, probe.chainPatch);
      evidence.push({
        toolRef,
        level: "dry_run",
        ok: probe.ok,
        detail: probe.detail,
        role: target.role,
      });
      dryRunLog.push({
        order: stepOrder,
        label: targetLabel(target, liveContract),
        actionSlug: target.actionSlug,
        toolkit: target.toolkit,
        role: target.role,
        ok: probe.ok,
        detail: probe.detail,
        payloadSummary: probe.payloadSummary,
      });
      const message = `${targetLabel(target, liveContract)}: ${probe.detail}`;
      if (!probe.ok) {
        if (target.role === "critical") failures.push(message);
        else warnings.push(`${message} (optional)`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${targetLabel(target, sessionContract ?? null)}: ${detail}`;
      evidence.push({ toolRef, level: "dry_run", ok: false, detail, role: target.role });
      dryRunLog.push({
        order: stepOrder,
        label: targetLabel(target, sessionContract ?? null),
        actionSlug: target.actionSlug,
        toolkit: target.toolkit,
        role: target.role,
        ok: false,
        detail,
      });
      if (target.role === "critical") failures.push(message);
      else warnings.push(`${message} (optional)`);
    }
  }

  for (const note of VERIFICATION_RUNTIME_TRANSPARENCY_NOTES) {
    stepOrder += 1;
    dryRunLog.push({
      order: stepOrder,
      label: "Runtime note",
      actionSlug: "internal.runtime_note",
      toolkit: "internal",
      role: "optional",
      ok: true,
      detail: note,
    });
  }

  const status: WorkflowVerificationStatus = failures.length > 0 ? "failed" : "awaiting_confirmation";
  const result = await pool.query<VerificationRow>(
    `UPDATE workflow_verification_runs
     SET status = $2, evidence_json = $3::jsonb, failures_json = $4::jsonb, warnings_json = $5::jsonb, updated_at = NOW()
     WHERE id = $1
     RETURNING id, workflow_id, status, evidence_json, failures_json, warnings_json, confirmed_at, created_at, updated_at`,
    [verification.id, status, JSON.stringify(evidence), JSON.stringify(failures), JSON.stringify(warnings)],
  );
  return mapRow(result.rows[0]!, dryRunLog);
}

export async function confirmWorkflowVerification(auth: AuthContext, workflowId: string): Promise<WorkflowVerificationView> {
  const verification = await getWorkflowVerification(auth, workflowId);
  const workflowStatus = await pool.query<{ status: string }>(
    `SELECT status FROM workflows
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  if (workflowStatus.rows[0]?.status === "active") {
    return verification ?? (await getWorkflowVerification(auth, workflowId))!;
  }
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
  const runnableSpec = parseRunnableSpec(metadata);
  if (!runnableSpec) {
    throw new Error("Workflow is missing a runnable spec. Re-save from the loop builder.");
  }
  const buildContract = runnableSpec.buildContract
    ?? runnableSpec.noSlopSpec.buildContract
    ?? runnableSpec.noSlopSpec.specJson.buildContract;
  const selectedTrigger = buildContract ? selectedLoopTrigger(buildContract) : null;
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
      const conflictingTrigger = await client.query<{ workflow_id: string; status: string }>(
        `SELECT wct.workflow_id, w.status
         FROM workflow_connector_triggers wct
         JOIN workflows w ON w.id = wct.workflow_id
         WHERE wct.trigger_instance_id = $1
           AND wct.workflow_id <> $2
           AND w.tenant_id = $3
           AND w.user_id = $4`,
        [registeredTrigger.triggerId, workflowId, auth.tenantId, auth.userId],
      );
      if (conflictingTrigger.rows.some((row) => row.status === "active")) {
        throw new Error("This event trigger is already assigned to another active loop. Archive that loop before activating this one.");
      }
      await client.query(
        `DELETE FROM workflow_connector_triggers
         WHERE trigger_instance_id = $1 AND workflow_id <> $2`,
        [registeredTrigger.triggerId, workflowId],
      );
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

  if (selectedTrigger?.mode === "schedule" && isTemporalEnabled()) {
    await upsertLoopSchedule({
      tenantId: auth.tenantId,
      userId: auth.userId,
      workflowId,
      cron: selectedTrigger.cron,
      timezone: selectedTrigger.timezone,
      label: scheduleTriggerLabel(selectedTrigger.cron),
    });
  }

  return (await getWorkflowVerification(auth, workflowId))!;
}

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { emitRunEvent } from "./spec-run-agent-events.js";
import { getSpecRunEditorialProjection } from "./spec-run-editorial-projection.js";

export type CanvasEmailSaveInput = {
  design?: unknown;
  html: string;
  text?: string;
  subject?: string;
  preview?: string;
  reactEmailSource?: string;
  editorContent?: string;
  designId?: string;
  source?: string;
  updatedAt?: string;
  finalUse?: boolean;
};

export async function saveCanvasEmailArtifact(input: {
  auth: AuthContext;
  runId: string;
  artifactKey: string;
  emailTemplate: CanvasEmailSaveInput;
}) {
  const existing = await pool.query<{
    tenant_id: string;
    user_id: string;
    step_attempt_id: string | null;
  }>(
    `SELECT a.tenant_id, a.user_id, a.step_attempt_id
     FROM loop_engine_artifacts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.run_id = $1
       AND a.artifact_key = $2
       AND a.kind = 'canvas_email'
       AND a.invalidated_at IS NULL
       AND r.tenant_id = $3
       AND r.user_id = $4
     ORDER BY a.version DESC
     LIMIT 1`,
    [input.runId, input.artifactKey, input.auth.tenantId, input.auth.userId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Canvas email artifact not found");

  const subject = input.emailTemplate.subject?.trim() || "Email draft";
  const preview = input.emailTemplate.preview?.trim() || subject;
  const emailTemplate = {
    design: input.emailTemplate.design,
    html: input.emailTemplate.html,
    text: input.emailTemplate.text ?? "",
    subject,
    preview,
    ...(input.emailTemplate.reactEmailSource ? { reactEmailSource: input.emailTemplate.reactEmailSource } : {}),
    ...(input.emailTemplate.editorContent ? { editorContent: input.emailTemplate.editorContent } : {}),
    ...(input.emailTemplate.designId ? { designId: input.emailTemplate.designId } : {}),
    updatedAt: input.emailTemplate.updatedAt ?? new Date().toISOString(),
    source: input.emailTemplate.source ?? "dashboard",
    finalUse: input.emailTemplate.finalUse ?? false,
  };

  await pool.query(
    `INSERT INTO loop_engine_artifacts
       (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, 'canvas_email', $6, $7::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      row.tenant_id,
      row.user_id,
      input.runId,
      row.step_attempt_id,
      input.artifactKey,
      emailTemplate.html,
      JSON.stringify({
        renderTarget: "canvas.email",
        emailTemplate,
      }),
    ],
  );

  await emitRunEvent({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: row.step_attempt_id ?? undefined,
    eventType: "canvas_email_saved",
    payload: { artifactKey: input.artifactKey },
  });

  return getSpecRunEditorialProjection(input.auth, input.runId);
}

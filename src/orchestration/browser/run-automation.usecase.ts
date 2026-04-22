import { pool } from "../../infrastructure/db/index.js";
import { cloudBrowserWorker } from "../../infrastructure/browser/browser-worker.client.js";
import { authContextFromUserId } from "../../infrastructure/auth/auth.js";
import type {
  OnboardingCheckpoint,
  OnboardingSession,
  OnboardingState,
  OnboardingStatus,
} from "./claude-onboarding.types.js";

export { ONBOARDING_STATES, ONBOARDING_STATUSES } from "./claude-onboarding.types.js";
export type {
  OnboardingCheckpoint,
  OnboardingSession,
  OnboardingState,
  OnboardingStatus,
} from "./claude-onboarding.types.js";

export interface OnboardingEvent {
  id: number;
  sessionId: string;
  eventType: string;
  state: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

type SessionRow = {
  id: string;
  user_id: string;
  status: OnboardingStatus;
  current_state: OnboardingState;
  project_name: string;
  checkpoint: unknown;
  metadata: unknown;
  last_error: string | null;
  completed_at: Date | null;
  canceled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type EventRow = {
  id: number;
  session_id: string;
  event_type: string;
  state: string | null;
  payload: unknown;
  created_at: Date;
};

const BASE_EXECUTION_STEPS: Exclude<OnboardingState, "queued">[] = [
  "browser_started",
  "claude_authenticated",
  "connector_connected",
  "project_upserted",
  "instructions_applied",
  "verified",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCheckpoint(value: unknown): OnboardingCheckpoint | null {
  if (!isObject(value)) return null;

  const typeRaw = value.type;
  const blockedStateRaw = value.blockedState ?? value.blocked_state;
  const messageRaw = value.message;
  const resumeHintRaw = value.resumeHint ?? value.resume_hint;
  const actionUrlRaw = value.actionUrl ?? value.action_url;

  if (
    typeRaw !== "auth" &&
    typeRaw !== "captcha" &&
    typeRaw !== "manual_review"
  ) {
    return null;
  }

  if (
    blockedStateRaw !== "browser_started" &&
    blockedStateRaw !== "claude_authenticated" &&
    blockedStateRaw !== "connector_connected" &&
    blockedStateRaw !== "project_upserted" &&
    blockedStateRaw !== "instructions_applied" &&
    blockedStateRaw !== "verified"
  ) {
    return null;
  }

  if (typeof messageRaw !== "string" || typeof resumeHintRaw !== "string") return null;

  const normalized: OnboardingCheckpoint = {
    type: typeRaw,
    blockedState: blockedStateRaw,
    message: messageRaw,
    resumeHint: resumeHintRaw,
  };

  if (typeof actionUrlRaw === "string") {
    normalized.actionUrl = actionUrlRaw;
  }

  return normalized;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapSessionRow(row: SessionRow): OnboardingSession {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    currentState: row.current_state,
    projectName: row.project_name,
    checkpoint: normalizeCheckpoint(row.checkpoint),
    metadata: isObject(row.metadata) ? row.metadata : {},
    lastError: row.last_error,
    completedAt: toIso(row.completed_at),
    canceledAt: toIso(row.canceled_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEventRow(row: EventRow): OnboardingEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    state: row.state,
    payload: isObject(row.payload) ? row.payload : null,
    createdAt: row.created_at.toISOString(),
  };
}

function shouldApplyProjectInstructions(session: OnboardingSession): boolean {
  const value = session.metadata["applyProjectInstructions"];
  if (typeof value === "boolean") return value;
  return true;
}

function computeExecutionSteps(session: OnboardingSession): Exclude<OnboardingState, "queued">[] {
  if (shouldApplyProjectInstructions(session)) return BASE_EXECUTION_STEPS;
  return BASE_EXECUTION_STEPS.filter((step) => step !== "instructions_applied");
}

function computeNextState(
  currentState: OnboardingState,
  executionSteps: Exclude<OnboardingState, "queued">[]
): Exclude<OnboardingState, "queued"> | null {
  if (currentState === "queued") {
    return executionSteps[0] ?? null;
  }
  const index = executionSteps.indexOf(currentState as Exclude<OnboardingState, "queued">);
  if (index === -1) return null;
  return executionSteps[index + 1] ?? null;
}

function isTerminalStatus(status: OnboardingStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export class ClaudeOnboardingService {
  private readonly running = new Set<string>();

  async createAndStart(userId: string, input?: {
    projectName?: string;
    applyProjectInstructions?: boolean;
    projectInstructions?: string;
  }): Promise<OnboardingSession> {
    const projectName = input?.projectName?.trim() || "Tallei Memory";
    const applyProjectInstructions = input?.applyProjectInstructions ?? true;
    const projectInstructions = typeof input?.projectInstructions === "string" ? input.projectInstructions.trim() : "";
    const metadataPatch: Record<string, unknown> = {
      applyProjectInstructions,
    };
    if (projectInstructions.length > 0) {
      metadataPatch["projectInstructions"] = projectInstructions;
    }
    const authContext = await authContextFromUserId(userId, "internal");
    const result = await pool.query<SessionRow>(
      `INSERT INTO claude_onboarding_sessions (tenant_id, user_id, status, current_state, project_name, metadata)
       VALUES ($1, $2, 'queued', 'queued', $3, $4::jsonb)
       RETURNING *`,
      [authContext.tenantId, userId, projectName, JSON.stringify(metadataPatch)]
    );

    const session = mapSessionRow(result.rows[0]);
    await this.logEvent(session.id, "session_created", "queued", {
      projectName,
      applyProjectInstructions,
      projectInstructionsProvided: projectInstructions.length > 0,
    });
    this.scheduleProcess(session.id);
    return session;
  }

  async getForUser(userId: string, sessionId: string): Promise<OnboardingSession | null> {
    const result = await pool.query<SessionRow>(
      `SELECT * FROM claude_onboarding_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    const row = result.rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async listEventsForUser(userId: string, sessionId: string): Promise<OnboardingEvent[] | null> {
    const ownership = await pool.query<{ id: string }>(
      `SELECT id FROM claude_onboarding_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    if (ownership.rows.length === 0) {
      return null;
    }

    const events = await pool.query<EventRow>(
      `SELECT id, session_id, event_type, state, payload, created_at
       FROM claude_onboarding_events
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );
    return events.rows.map(mapEventRow);
  }

  async cancel(userId: string, sessionId: string): Promise<OnboardingSession | null> {
    const session = await this.getForUser(userId, sessionId);
    if (!session) return null;
    if (isTerminalStatus(session.status)) return session;

    const result = await pool.query<SessionRow>(
      `UPDATE claude_onboarding_sessions
       SET status = 'canceled',
           canceled_at = NOW(),
           updated_at = NOW(),
           checkpoint = NULL
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [sessionId, userId]
    );
    const updated = mapSessionRow(result.rows[0]);
    await this.logEvent(sessionId, "session_canceled", updated.currentState, null);
    return updated;
  }

  async resume(userId: string, sessionId: string, input?: { authCompleted?: boolean }): Promise<OnboardingSession | null> {
    const session = await this.getForUser(userId, sessionId);
    if (!session) return null;
    if (session.status !== "checkpoint_required") return session;

    const metadataPatch: Record<string, unknown> = {};
    if (input?.authCompleted) {
      metadataPatch.authCompleted = true;
    }

    const result = await pool.query<SessionRow>(
      `UPDATE claude_onboarding_sessions
       SET status = 'queued',
           checkpoint = NULL,
           metadata = metadata || $3::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [sessionId, userId, JSON.stringify(metadataPatch)]
    );
    const updated = mapSessionRow(result.rows[0]);
    await this.logEvent(sessionId, "session_resumed", updated.currentState, { authCompleted: input?.authCompleted === true });
    this.scheduleProcess(sessionId);
    return updated;
  }

  private scheduleProcess(sessionId: string): void {
    setTimeout(() => {
      void this.process(sessionId);
    }, 0);
  }

  private async process(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);

    try {
      while (true) {
        const session = await this.getById(sessionId);
        if (!session) return;
        if (isTerminalStatus(session.status)) return;

        if (session.status === "checkpoint_required") {
          return;
        }

        if (session.status !== "running") {
          await this.updateSessionStatus(sessionId, "running");
        }

        const executionSteps = computeExecutionSteps(session);
        const nextState = computeNextState(session.currentState, executionSteps);
        if (!nextState) {
          await this.completeSession(sessionId);
          await this.logEvent(sessionId, "session_completed", session.currentState, null);
          return;
        }

        await this.logEvent(sessionId, "step_started", nextState, null);
        const outcome = await cloudBrowserWorker.execute(session, nextState);

        if (outcome.kind === "checkpoint") {
          await this.setCheckpoint(sessionId, outcome.checkpoint, outcome.metadataPatch);
          await this.logEvent(sessionId, "checkpoint_required", nextState, {
            checkpoint: outcome.checkpoint,
            diagnostics: outcome.diagnostics || null,
          });
          return;
        }

        if (outcome.kind === "error") {
          await this.failSession(sessionId, outcome.message);
          await this.logEvent(sessionId, "step_failed", nextState, {
            error: outcome.message,
            diagnostics: outcome.diagnostics || null,
          });
          return;
        }

        await this.markStepComplete(sessionId, nextState, outcome.metadataPatch);
        await this.logEvent(sessionId, "step_completed", nextState, {
          diagnostics: outcome.diagnostics || null,
          metadataPatch: outcome.metadataPatch || null,
        });

        if (nextState === "verified") {
          await this.completeSession(sessionId);
          await this.logEvent(sessionId, "session_completed", nextState, null);
          return;
        }
      }
    } finally {
      this.running.delete(sessionId);
    }
  }

  private async getById(sessionId: string): Promise<OnboardingSession | null> {
    const result = await pool.query<SessionRow>(
      `SELECT * FROM claude_onboarding_sessions WHERE id = $1`,
      [sessionId]
    );
    const row = result.rows[0];
    return row ? mapSessionRow(row) : null;
  }

  private async updateSessionStatus(sessionId: string, status: OnboardingStatus): Promise<void> {
    await pool.query(
      `UPDATE claude_onboarding_sessions
       SET status = $2, updated_at = NOW()
       WHERE id = $1`,
      [sessionId, status]
    );
  }

  private async markStepComplete(
    sessionId: string,
    nextState: Exclude<OnboardingState, "queued">,
    metadataPatch?: Record<string, unknown>
  ): Promise<void> {
    await pool.query(
      `UPDATE claude_onboarding_sessions
       SET current_state = $2,
           status = 'running',
           checkpoint = NULL,
           metadata = metadata || $3::jsonb,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId, nextState, JSON.stringify(metadataPatch || {})]
    );
  }

  private async setCheckpoint(
    sessionId: string,
    checkpoint: OnboardingCheckpoint,
    metadataPatch?: Record<string, unknown>
  ): Promise<void> {
    await pool.query(
      `UPDATE claude_onboarding_sessions
       SET status = 'checkpoint_required',
           checkpoint = $2::jsonb,
           metadata = metadata || $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId, JSON.stringify(checkpoint), JSON.stringify(metadataPatch || {})]
    );
  }

  private async failSession(sessionId: string, message: string): Promise<void> {
    await pool.query(
      `UPDATE claude_onboarding_sessions
       SET status = 'failed',
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId, message]
    );
  }

  private async completeSession(sessionId: string): Promise<void> {
    await pool.query(
      `UPDATE claude_onboarding_sessions
       SET status = 'completed',
           completed_at = COALESCE(completed_at, NOW()),
           checkpoint = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId]
    );
  }

  private async logEvent(sessionId: string, eventType: string, state: string | null, payload: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO claude_onboarding_events (tenant_id, session_id, event_type, state, payload)
       SELECT cos.tenant_id, $1, $2, $3, $4::jsonb
       FROM claude_onboarding_sessions cos
       WHERE cos.id = $1`,
      [sessionId, eventType, state, payload ? JSON.stringify(payload) : null]
    );
  }
}

export const claudeOnboardingService = new ClaudeOnboardingService();

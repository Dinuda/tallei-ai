import { config } from "../../config/index.js";
import { pool } from "../db/index.js";
import type {
  FlowTemplate,
  OnboardingActionState,
  WinningAction,
} from "./flow-template-store.types.js";

type FlowTemplateRow = {
  state: string;
  actions: unknown;
  success_count: number;
  is_learned: boolean;
  last_succeeded_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function isWinningAction(value: unknown): value is WinningAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.type !== "click" && item.type !== "fill" && item.type !== "goto") return false;
  if (typeof item.selector !== "string") return false;
  if (item.value !== undefined && typeof item.value !== "string") return false;
  return true;
}

function parseActions(value: unknown): WinningAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isWinningAction);
}

function mapRow(row: FlowTemplateRow): FlowTemplate {
  return {
    state: row.state as OnboardingActionState,
    actions: parseActions(row.actions),
    successCount: row.success_count,
    isLearned: row.is_learned,
    lastSucceededAt: row.last_succeeded_at ? row.last_succeeded_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

class FlowTemplateStore {
  private readonly learnedCache = new Map<OnboardingActionState, FlowTemplate>();

  async getLearnedPolicy(state: OnboardingActionState): Promise<FlowTemplate | null> {
    const cached = this.learnedCache.get(state);
    if (cached) return cached;

    const result = await pool.query<FlowTemplateRow>(
      `SELECT state, actions, success_count, is_learned, last_succeeded_at, created_at, updated_at
       FROM browser_flow_templates
       WHERE state = $1 AND is_learned = TRUE
       LIMIT 1`,
      [state]
    );

    const row = result.rows[0];
    if (!row) return null;
    const mapped = mapRow(row);
    this.learnedCache.set(state, mapped);
    return mapped;
  }

  async recordSuccess(state: OnboardingActionState, actions: WinningAction[]): Promise<void> {
    const threshold = Math.max(1, config.browserTeacherThreshold);
    const result = await pool.query<FlowTemplateRow>(
      `INSERT INTO browser_flow_templates (
         state,
         actions,
         success_count,
         is_learned,
         last_succeeded_at,
         created_at,
         updated_at
       )
       VALUES ($1, $2::jsonb, 1, (1 >= $3), NOW(), NOW(), NOW())
       ON CONFLICT (state)
       DO UPDATE SET
         actions = EXCLUDED.actions,
         success_count = browser_flow_templates.success_count + 1,
         is_learned = (browser_flow_templates.success_count + 1) >= $3,
         last_succeeded_at = NOW(),
         updated_at = NOW()
       RETURNING state, actions, success_count, is_learned, last_succeeded_at, created_at, updated_at`,
      [state, JSON.stringify(actions), threshold]
    );

    const row = result.rows[0];
    if (!row) return;
    const mapped = mapRow(row);
    if (mapped.isLearned) {
      this.learnedCache.set(state, mapped);
      return;
    }
    this.learnedCache.delete(state);
  }

  invalidate(state: OnboardingActionState): void {
    this.learnedCache.delete(state);
  }
}

export const flowTemplateStore = new FlowTemplateStore();

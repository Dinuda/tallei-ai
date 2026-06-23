import { z } from "zod";

export const saveLoopInputSchema = z.object({
  cron: z.string().trim().min(1).nullable().optional(),
  timezone: z.string().trim().min(1).nullable().optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

export const saveLoopRequestSchema = z.object({
  sessionId: z.string().uuid(),
  ...saveLoopInputSchema.shape,
});

export type SaveLoopInput = z.infer<typeof saveLoopInputSchema>;
export type SaveLoopRequest = z.infer<typeof saveLoopRequestSchema>;

export function normalizeSaveLoopInput(input: SaveLoopInput): {
  cron?: string;
  timezone?: string;
  workspaceId?: string | null;
} {
  const normalized: {
    cron?: string;
    timezone?: string;
    workspaceId?: string | null;
  } = {};

  const cron = input.cron?.trim();
  if (cron) normalized.cron = cron;

  const timezone = input.timezone?.trim();
  if (timezone) normalized.timezone = timezone;

  if (input.workspaceId !== null && input.workspaceId !== undefined) {
    normalized.workspaceId = input.workspaceId;
  }

  return normalized;
}

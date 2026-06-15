import { z } from "zod";

export const workspaceKindSchema = z.enum(["personal", "custom"]);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export interface WorkspaceView {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: WorkspaceKind;
  isDefault: boolean;
  icon: string | null;
  color: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
});

export const updateWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

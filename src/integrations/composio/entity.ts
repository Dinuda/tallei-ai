import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";

export type ParsedComposioEntityId = {
  prefix: string;
  tenantId: string;
  userId: string;
  workspaceId?: string;
};

export function parseComposioEntityId(entityId: string): ParsedComposioEntityId | null {
  const trimmed = entityId.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  const [prefix, tenantId, userId, workspaceId] = parts;
  if (!prefix || !tenantId || !userId) return null;
  return {
    prefix,
    tenantId,
    userId,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function buildAuthContextFromEntity(entityId: string): AuthContext | null {
  const parsed = parseComposioEntityId(entityId);
  if (!parsed) return null;
  if (parsed.prefix !== config.composioEntityPrefix) return null;
  return {
    userId: parsed.userId,
    tenantId: parsed.tenantId,
    authMode: "internal",
    plan: "free",
    ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
  };
}

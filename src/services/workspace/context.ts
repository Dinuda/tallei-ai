import type { AuthContext } from "../../domain/auth/index.js";

export function requireWorkspaceId(auth: AuthContext): string {
  if (!auth.workspaceId) throw new Error("Workspace context is required");
  return auth.workspaceId;
}

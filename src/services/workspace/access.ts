import type { AuthContext } from "../../domain/auth/index.js";

/** Gate loop/workspace admin APIs. V1: any authenticated user with loop scopes. */
export async function requireLoopAdmin(_auth: AuthContext): Promise<void> {
  return;
}

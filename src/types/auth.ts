export type AuthMode = "api_key" | "oauth" | "jwt" | "internal" | "unknown";

export type Plan = "free" | "pro" | "power";

export interface AuthContext {
  userId: string;
  tenantId: string;
  authMode: AuthMode;
  plan: Plan;
  keyId?: string;
  connectorType?: string | null;
  clientId?: string;
  scopes?: string[];
}

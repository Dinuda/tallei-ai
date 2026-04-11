export type AuthMode = "api_key" | "oauth" | "jwt" | "internal" | "unknown";

export interface AuthContext {
  userId: string;
  tenantId: string;
  authMode: AuthMode;
  keyId?: string;
  connectorType?: string | null;
}

import type { AuthContext } from "../../domain/auth/index.js";

export type ConnectorToolkit = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  category?: string;
  connected: boolean;
  connectedAccountId?: string;
};

export type ConnectorAction = {
  toolkit: string;
  actionSlug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  toolkitVersion?: string;
  toolkitName?: string;
  tags?: string[];
};

export type ConnectorTrigger = { slug: string; name: string; config?: Record<string, unknown> };

export type ConnectorConnection = {
  toolkit: string;
  connected: boolean;
  connectedAccountId?: string;
  status: "connected" | "disconnected" | "pending";
};

export interface ConnectorProvider {
  readonly id: string;
  listCatalog(): Promise<ConnectorToolkit[]>;
  listCatalogWithConnections(auth: AuthContext): Promise<ConnectorToolkit[]>;
  searchActions(query: string, limit?: number): Promise<ConnectorAction[]>;
  listActions(toolkit: string): Promise<ConnectorAction[]>;
  listTriggers(toolkit: string): Promise<ConnectorTrigger[]>;
  registerTrigger(input: {
    auth: AuthContext;
    loopId: string;
    workspaceId: string;
    toolkit: string;
    triggerSlug?: string;
    eventType?: string;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  unregisterTrigger(loopId: string): Promise<void>;
  getLatestToolkitVersion(toolkit: string): Promise<string>;
  getConnection(auth: AuthContext, toolkit: string): Promise<ConnectorConnection>;
  startConnection(auth: AuthContext, toolkit: string, callbackUrl?: string): Promise<{
    redirectUrl: string;
    connectionRequestId: string;
  }>;
  verifyConnection(auth: AuthContext, input: {
    toolkit?: string;
    connectionRequestId?: string;
    timeoutMs?: number;
  }): Promise<ConnectorConnection>;
  disconnect(auth: AuthContext, toolkit: string): Promise<void>;
  execute(input: {
    auth: AuthContext;
    toolkit: string;
    actionSlug: string;
    connectedAccountId: string;
    args: Record<string, unknown>;
    toolkitVersion?: string;
  }): Promise<unknown>;
}

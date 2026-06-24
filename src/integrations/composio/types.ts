import type { Session } from "@composio/core";
import type { VercelProvider } from "@composio/vercel";

export type ComposioToolkitView = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  category?: string;
  connected?: boolean;
  connectedAccountId?: string;
};

export type ComposioActionView = {
  toolkit: string;
  actionSlug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  toolkitVersion?: string;
};

export type ComposioToolSearchResult = ComposioActionView & {
  toolkitName: string;
  tags: string[];
};

export type ComposioAgentSession = {
  sessionId: string;
  userId: string;
  client: Session<unknown, unknown, VercelProvider>;
};

export type ComposioSandboxSize = "standard" | "medium" | "large" | "xlarge";

export type CreateSessionOptions = {
  toolkits?: string[] | { enable?: string[]; disable?: string[] };
  preload?: { tools?: string[] | "all" };
  authConfigs?: Record<string, string>;
  connectedAccounts?: Record<string, string | string[]>;
  workbench?: { enable?: boolean; sandboxSize?: ComposioSandboxSize };
  manageConnections?: { enable?: boolean };
};

export type ComposioConnectedAccount = {
  id: string;
  status?: string;
};

export type ComposioAuthorizeResult = {
  redirectUrl: string;
  connectionRequestId: string;
  waitForConnection: (timeout?: number) => Promise<ComposioConnectedAccount>;
};

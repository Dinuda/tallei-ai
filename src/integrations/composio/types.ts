export type ComposioToolkitView = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  category?: string;
  connected: boolean;
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

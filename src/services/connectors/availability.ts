import type { AuthContext } from "../../domain/auth/index.js";
import type { ToolContract } from "../tool-spec/types.js";
import { createComposioSession, invalidateComposioSession } from "./composio-session.js";
import {
  connectedAppToolkits,
  listComposioToolkits,
  reconcileComposioConnectorAccounts,
} from "./composio.js";

export type ConnectorAvailabilityState =
  | "not_connected"
  | "authorizing"
  | "connected_pending_action_visibility"
  | "connected"
  | "expired"
  | "failed";

export type ConnectorAvailabilityAction = {
  slug: string;
  name: string;
  description: string;
  effect: ToolContract["effect"];
  available: boolean;
};

export type ConnectorAvailabilityApp = {
  toolkit: string;
  name: string;
  logo: string;
  state: ConnectorAvailabilityState;
  accountConnected: boolean;
  accounts: Array<{
    id: string;
    status: string;
  }>;
  selectedAccountIds: string[];
  actions: ConnectorAvailabilityAction[];
  unavailableActionSlugs: string[];
};

export type ConnectorAvailabilitySnapshot = {
  checkedAt: string;
  composioSessionId: string;
  apps: ConnectorAvailabilityApp[];
};

function toolkitFor(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? contract.name.toLowerCase();
}

function actionSlugFor(contract: ToolContract): string {
  return String(contract.constraints.actionSlug ?? contract.name).trim().toUpperCase();
}

export async function resolveConnectorAvailability(input: {
  auth: AuthContext;
  contracts: ToolContract[];
  previousComposioSessionId?: string | null;
  selectedAccountIdsByToolkit?: Record<string, string[]>;
}): Promise<{ snapshot: ConnectorAvailabilitySnapshot; contracts: ToolContract[] }> {
  if (input.previousComposioSessionId) invalidateComposioSession(input.previousComposioSessionId);
  const connectorContracts = input.contracts.filter((contract) => contract.provider === "composio");
  const requestedToolkits = [...new Set(connectorContracts.map(toolkitFor))];
  const [accounts, toolkitMetadata] = await Promise.all([
    reconcileComposioConnectorAccounts({ auth: input.auth, toolkits: requestedToolkits }).catch(() => []),
    listComposioToolkits().catch(() => []),
  ]);
  const connectedToolkits = new Set(connectedAppToolkits(accounts));
  const connectedAccounts: Record<string, string> = {};
  const selectedAccountIdsByToolkit: Record<string, string[]> = {};
  for (const toolkit of connectedToolkits) {
    const selectedIds = input.selectedAccountIdsByToolkit?.[toolkit] ?? [];
    const selected = accounts.find((account) => selectedIds.includes(account.id) && account.status === "connected");
    const connectedForToolkit = accounts.filter((account) => account.toolkit === toolkit && account.status === "connected");
    const account = selected ?? connectedForToolkit[0];
    if (account) {
      connectedAccounts[toolkit] = account.externalAccountId;
      selectedAccountIdsByToolkit[toolkit] = [account.id];
    }
  }
  const session = await createComposioSession(input.auth, connectedAccounts);
  const tools = await session.client.tools();
  const visibleSlugs = new Set(Object.keys(tools ?? {}).map((slug) => slug.trim().toUpperCase()));
  const metadataBySlug = new Map(toolkitMetadata.map((toolkit) => [toolkit.slug.trim().toLowerCase(), toolkit]));
  const grouped = new Map<string, ToolContract[]>();
  for (const contract of connectorContracts) {
    const toolkit = toolkitFor(contract);
    grouped.set(toolkit, [...(grouped.get(toolkit) ?? []), contract]);
  }

  const apps = [...grouped.entries()].map(([toolkit, contracts]): ConnectorAvailabilityApp => {
    const accountConnected = connectedToolkits.has(toolkit);
    const actions = contracts.map((contract): ConnectorAvailabilityAction => {
      const slug = actionSlugFor(contract);
      return {
        slug,
        name: contract.name,
        description: contract.description,
        effect: contract.effect,
        available: visibleSlugs.has(slug),
      };
    });
    const unavailableActionSlugs = actions.filter((action) => !action.available).map((action) => action.slug);
    const metadata = metadataBySlug.get(toolkit);
    const selectedAccountIds = selectedAccountIdsByToolkit[toolkit] ?? [];
    const appAccounts = accounts
      .filter((account) => account.toolkit === toolkit && selectedAccountIds.includes(account.id))
      .map((account) => ({
        id: account.id,
        status: account.status,
      }));
    return {
      toolkit,
      name: metadata?.name || toolkit.replace(/[-_]/g, " ").replace(/\b\w/g, (value) => value.toUpperCase()),
      logo: metadata?.logo || `https://logos.composio.dev/api/${toolkit}`,
      state: !accountConnected
        ? "not_connected"
        : unavailableActionSlugs.length > 0
          ? "connected_pending_action_visibility"
          : "connected",
      accountConnected,
      accounts: appAccounts,
      selectedAccountIds,
      actions,
      unavailableActionSlugs,
    };
  });

  const refreshedContracts = input.contracts.map((contract) => {
    if (contract.provider !== "composio") return contract;
    const toolkit = toolkitFor(contract);
    return {
      ...contract,
      constraints: {
        ...contract.constraints,
        connected: connectedToolkits.has(toolkit),
        actionVisible: visibleSlugs.has(actionSlugFor(contract)),
      },
    };
  });
  return {
    snapshot: {
      checkedAt: new Date().toISOString(),
      composioSessionId: session.sessionId,
      apps,
    },
    contracts: refreshedContracts,
  };
}

import type { ConnectorProvider } from "./provider.js";
import {
  disconnectToolkit,
  getToolkitConnectionStatus,
  listAllToolkitsWithStatus,
  startToolkitAuthorization,
  verifyToolkitConnection,
} from "../composio/accounts.js";
import { executeComposioAction } from "../composio/execute.js";
import {
  listComposioTriggerTypes,
  registerLoopEventTrigger,
  unregisterLoopEventTrigger,
} from "../composio/triggers.js";
import { getAllTools, getLatestToolkitVersion, listToolkits, searchTools } from "../composio/tools.js";

export const composioConnectorProvider: ConnectorProvider = {
  id: "composio",
  listCatalog: listToolkits,
  async listCatalogWithConnections(auth) {
    return (await listAllToolkitsWithStatus(auth)).toolkits;
  },
  searchActions: searchTools,
  listActions: getAllTools,
  listTriggers: listComposioTriggerTypes,
  async registerTrigger(input) {
    return registerLoopEventTrigger({
      auth: input.auth,
      loopId: input.loopId,
      workspaceId: input.workspaceId,
      source: input.toolkit,
      ...(input.triggerSlug ? { composioSlug: input.triggerSlug } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      config: input.config ?? {},
    });
  },
  unregisterTrigger: unregisterLoopEventTrigger,
  getLatestToolkitVersion,
  getConnection: getToolkitConnectionStatus,
  async startConnection(auth, toolkit, callbackUrl) {
    const result = await startToolkitAuthorization(auth, toolkit, { ...(callbackUrl ? { callbackUrl } : {}) });
    return { redirectUrl: result.redirectUrl, connectionRequestId: result.connectionRequestId };
  },
  verifyConnection: verifyToolkitConnection,
  async disconnect(auth, toolkit) {
    await disconnectToolkit(auth, toolkit);
  },
  async execute(input) {
    return executeComposioAction({
      auth: input.auth,
      connector: input.toolkit,
      actionSlug: input.actionSlug,
      credentialRef: input.connectedAccountId,
      args: input.args,
      ...(input.toolkitVersion ? { toolkitVersion: input.toolkitVersion } : {}),
    });
  },
};

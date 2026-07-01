import type { ConnectorProvider } from "./provider.js";
import { composioConnectorProvider } from "./composio-provider.js";

const providers = new Map<string, ConnectorProvider>([
  [composioConnectorProvider.id, composioConnectorProvider],
]);

export function getConnectorProvider(id = "composio"): ConnectorProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown connector provider: ${id}`);
  return provider;
}

export type {
  ConnectorAction,
  ConnectorConnection,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectorTrigger,
} from "./provider.js";

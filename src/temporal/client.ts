import { Client, Connection } from "@temporalio/client";

import { config } from "../config/index.js";

let clientPromise: Promise<Client> | null = null;

export function isTemporalEnabled(): boolean {
  return config.temporalEnabled;
}

export async function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const connection = await Connection.connect({ address: config.temporalAddress });
      return new Client({ connection, namespace: config.temporalNamespace });
    })();
  }
  return clientPromise;
}

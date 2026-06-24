import { Connection, Client } from "@temporalio/client";

import { config } from "../config/index.js";
import type { ApprovalDecision } from "./types.js";

let clientPromise: Promise<Client> | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const connection = await Connection.connect({ address: config.temporalAddress });
      return new Client({ connection, namespace: config.temporalNamespace });
    })();
  }
  return clientPromise;
}

export async function signalApprovalDecision(
  workflowId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal("approvalDecision", decision);
}

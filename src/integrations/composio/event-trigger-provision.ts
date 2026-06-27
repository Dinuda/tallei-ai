import type { AuthContext } from "../../domain/auth/index.js";
import { resolveConnectedAccountId } from "./accounts.js";
import { resolveToolkitSlug } from "./auth.js";
import { isComposioConfigured } from "./client.js";
import {
  deactivateLoopTriggerSubscription,
  ensureWorkspaceTriggerChannel,
  getLoopTriggerSubscription,
  releaseWorkspaceTriggerChannel,
  upsertLoopTriggerSubscription,
} from "./trigger-channels.js";
import { ensureComposioWebhookSubscription } from "./webhook-subscription.js";

export type EventTriggerProvisionReceipt = {
  composioTriggerSlug: string;
  composioInstanceId: string | null;
  subscribed: true;
};

export async function provisionEventTrigger(input: {
  auth: AuthContext;
  loopId: string;
  workspaceId: string;
  source: string;
  composioSlug?: string;
  eventType?: string;
}): Promise<EventTriggerProvisionReceipt> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const toolkit = await resolveToolkitSlug(input.source);
  const { resolveCanonicalTriggerSlug } = await import("./triggers.js");
  const composioTriggerSlug = await resolveCanonicalTriggerSlug(toolkit, {
    composioSlug: input.composioSlug,
    eventType: input.eventType,
  });

  const connectedAccountId = await resolveConnectedAccountId(input.auth, toolkit);
  if (!connectedAccountId) {
    throw new Error(`Connect ${toolkit} before enabling its event trigger`);
  }

  const existing = await getLoopTriggerSubscription(input.loopId);
  if (existing?.status === "active" && existing.channel_id) {
    await deactivateLoopTriggerSubscription(input.loopId);
    await releaseWorkspaceTriggerChannel(existing.channel_id);
  }

  const channel = await ensureWorkspaceTriggerChannel({
    workspaceId: input.workspaceId,
    toolkit,
    connectedAccountId,
    composioTriggerSlug,
  });

  const webhook = await ensureComposioWebhookSubscription();
  if (!webhook.configured) {
    console.warn("[integrations/composio] trigger provisioned but webhook delivery may not work", {
      loopId: input.loopId,
      reason: webhook.reason,
      webhookUrl: webhook.webhookUrl,
    });
  }

  await upsertLoopTriggerSubscription({
    loopId: input.loopId,
    workspaceId: input.workspaceId,
    channelId: channel.id,
  });

  return {
    composioTriggerSlug,
    composioInstanceId: channel.composio_instance_id,
    subscribed: true,
  };
}

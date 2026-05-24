import { config } from "../../config/index.js";
import { createLogger } from "../../observability/index.js";

export interface AdminSlackMessageInput {
  text: string;
  blocks?: unknown[];
}

export interface AdminSlackMessageResult {
  sent: boolean;
  skipped: boolean;
  status?: number;
  error?: string;
}

const logger = createLogger({ baseFields: { component: "admin_slack" } });
const WEBHOOK_TIMEOUT_MS = 8_000;

export async function sendAdminSlackMessage(input: AdminSlackMessageInput): Promise<AdminSlackMessageResult> {
  const url = config.adminSlackWebhookUrl;
  if (!url) return { sent: false, skipped: true, error: "TALLEI_ADMIN__SLACK_WEBHOOK_URL is not configured" };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      const error = `Webhook returned ${response.status}${responseText ? `: ${responseText}` : ""}`;
      logger.error("admin slack webhook failed", { status: response.status, error });
      return { sent: false, skipped: false, status: response.status, error };
    }
    return { sent: true, skipped: false, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("admin slack webhook crashed", { error: message });
    return { sent: false, skipped: false, error: message };
  }
}

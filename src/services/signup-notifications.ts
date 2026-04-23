import { config } from "../config/index.js";
import { buildWelcomeEmailTemplate } from "./email-templates.js";
import { sendResendEmail } from "./resend-email.js";

export interface SignupNotificationInput {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
}

type DeliveryChannel = "resend_email" | "slack";

interface DeliveryResult {
  readonly channel: DeliveryChannel;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

const WEBHOOK_TIMEOUT_MS = 8_000;

async function postJsonWebhook(
  url: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ ok: boolean; status: number; responseText: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  const responseText = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, responseText };
}

async function sendResendSignupEmail(input: SignupNotificationInput): Promise<DeliveryResult> {
  const template = buildWelcomeEmailTemplate(input.email);
  const result = await sendResendEmail({
    to: input.email,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });
  return {
    channel: "resend_email",
    ok: result.ok,
    status: result.status,
    error: result.error,
  };
}

async function sendSlackSignupWebhook(input: SignupNotificationInput): Promise<DeliveryResult> {
  const url = config.signupSlackWebhookUrl;
  if (!url) {
    return { channel: "slack", ok: true };
  }

  const text = [
    "New signup",
    `Email: ${input.email}`,
    `User ID: ${input.userId}`,
    `Tenant ID: ${input.tenantId}`,
  ].join("\n");

  try {
    const result = await postJsonWebhook(url, {
      text,
    });

    if (!result.ok) {
      return {
        channel: "slack",
        ok: false,
        status: result.status,
        error: `Webhook returned ${result.status}${result.responseText ? `: ${result.responseText}` : ""}`,
      };
    }

    return { channel: "slack", ok: true, status: result.status };
  } catch (error) {
    return {
      channel: "slack",
      ok: false,
      error: error instanceof Error ? error.message : "Unknown webhook error",
    };
  }
}

async function pingFailureService(
  input: SignupNotificationInput,
  failures: DeliveryResult[]
): Promise<void> {
  if (!config.signupFailurePingWebhookUrl) return;

  const headers: Record<string, string> = {};
  if (config.signupFailurePingWebhookToken) {
    headers.Authorization = `Bearer ${config.signupFailurePingWebhookToken}`;
  }

  await postJsonWebhook(
    config.signupFailurePingWebhookUrl,
    {
      event: "signup_notification_failure",
      occurredAt: new Date().toISOString(),
      user: {
        id: input.userId,
        tenantId: input.tenantId,
        email: input.email,
      },
      failures: failures.map((entry) => ({
        channel: entry.channel,
        status: entry.status ?? null,
        error: entry.error ?? null,
      })),
    },
    headers
  );
}

export async function notifyUserSignup(input: SignupNotificationInput): Promise<void> {
  const [resendResult, slackResult] = await Promise.all([
    sendResendSignupEmail(input),
    sendSlackSignupWebhook(input),
  ]);

  const failures = [resendResult, slackResult].filter((entry) => !entry.ok);
  if (failures.length === 0) return;

  console.error("[signup] notification delivery failed", {
    userId: input.userId,
    email: input.email,
    failures,
  });

  try {
    await pingFailureService(input, failures);
  } catch (error) {
    console.error("[signup] failure ping webhook failed", error);
  }
}

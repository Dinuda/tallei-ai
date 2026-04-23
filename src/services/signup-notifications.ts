import { config } from "../config/index.js";

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

function buildFounderWelcomeMessage(email: string): string {
  const fallbackName = email.includes("@") ? email.split("@")[0] : "there";
  const firstName = fallbackName.split(/[._-]/)[0] || "there";
  const normalizedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  return [
    `Hi ${normalizedFirstName},`,
    "",
    "I'm Dinuda, founder of Tallei. Thanks for signing up.",
    "",
    "Tallei is a memory layer for AI assistants.",
    "People usually come to Tallei so Claude, ChatGPT, and Gemini remember their context, preferences, and past decisions across sessions.",
    "",
    "Most teams use it to stop re-explaining the same things, keep responses consistent, and move faster.",
    "",
    "If you want, just reply and I can help you get the setup right for your workflow.",
    "",
    "Best,",
    "",
    "Dinuda",
    "Founder, Tallei",
  ].join("\n");
}

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
  if (!config.signupResendApiKey) {
    return { channel: "resend_email", ok: true };
  }
  if (!config.signupEmailFromEmail) {
    return {
      channel: "resend_email",
      ok: false,
      error: "TALLEI_SIGNUP__EMAIL_FROM_EMAIL is required when Resend is enabled",
    };
  }

  const founderMessage = buildFounderWelcomeMessage(input.email);
  const subject = "Welcome to Tallei";
  const from = `${config.signupEmailFromName} <${config.signupEmailFromEmail}>`;

  try {
    const result = await postJsonWebhook(
      "https://api.resend.com/emails",
      {
        from,
        to: [input.email],
        subject,
        text: founderMessage,
        reply_to: config.signupEmailReplyTo || undefined,
      },
      {
        Authorization: `Bearer ${config.signupResendApiKey}`,
      }
    );

    if (!result.ok) {
      return {
        channel: "resend_email",
        ok: false,
        status: result.status,
        error: `Webhook returned ${result.status}${result.responseText ? `: ${result.responseText}` : ""}`,
      };
    }

    return { channel: "resend_email", ok: true, status: result.status };
  } catch (error) {
    return {
      channel: "resend_email",
      ok: false,
      error: error instanceof Error ? error.message : "Unknown webhook error",
    };
  }
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

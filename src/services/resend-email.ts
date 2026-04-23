import { config } from "../config/index.js";

export interface ResendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
}

export interface ResendEmailResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

const RESEND_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;

async function postJson(
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseText = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, responseText };
}

export async function sendResendEmail(input: ResendEmailInput): Promise<ResendEmailResult> {
  if (!config.signupResendApiKey) {
    return { ok: true };
  }

  if (!config.signupEmailFromEmail) {
    return {
      ok: false,
      error: "TALLEI_SIGNUP__EMAIL_FROM_EMAIL is required when Resend is enabled",
    };
  }

  const from = `${config.signupEmailFromName} <${config.signupEmailFromEmail}>`;
  const replyTo = input.replyTo ?? (config.signupEmailReplyTo || undefined);

  try {
    const result = await postJson(
      RESEND_URL,
      {
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        reply_to: replyTo,
      },
      {
        Authorization: `Bearer ${config.signupResendApiKey}`,
      }
    );

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: `Webhook returned ${result.status}${result.responseText ? `: ${result.responseText}` : ""}`,
      };
    }

    return { ok: true, status: result.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown webhook error",
    };
  }
}

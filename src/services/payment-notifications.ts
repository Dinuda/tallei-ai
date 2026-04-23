import { config } from "../config/index.js";
import { buildPaymentSuccessEmailTemplate } from "./email-templates.js";
import { sendResendEmail } from "./resend-email.js";

export interface PaymentSuccessNotificationInput {
  readonly email: string;
  readonly plan: string;
  readonly currentPeriodEnd: Date | null;
}

export async function notifyPaymentSuccess(input: PaymentSuccessNotificationInput): Promise<void> {
  const manageBillingUrl = new URL("/dashboard/billing", config.dashboardBaseUrl).toString();
  const template = buildPaymentSuccessEmailTemplate({
    email: input.email,
    plan: input.plan,
    currentPeriodEnd: input.currentPeriodEnd,
    manageBillingUrl,
  });

  const result = await sendResendEmail({
    to: input.email,
    subject: template.subject,
    text: template.text,
    html: template.html,
  });

  if (!result.ok) {
    console.error("[billing] payment success email failed", {
      email: input.email,
      status: result.status,
      error: result.error,
    });
  }
}

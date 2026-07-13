export interface EmailTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface PaymentSuccessTemplateInput {
  readonly email: string;
  readonly plan: string;
  readonly currentPeriodEnd: Date | null;
  readonly manageBillingUrl: string;
}

export function resolveFirstName(email: string): string {
  const fallbackName = email.includes("@") ? email.split("@")[0] : "there";
  const firstName = fallbackName.split(/[._-]/)[0] || "there";
  return firstName.charAt(0).toUpperCase() + firstName.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPlainHtml(paragraphs: readonly string[]): string {
  const paragraphHtml = paragraphs
    .map((paragraph) => {
      if (paragraph.trim().length === 0) {
        return `<div style="height:4px;"></div>`;
      }
      return `<p style="margin:0 0 8px;line-height:1.45;">${escapeHtml(paragraph)}</p>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tallei</title>
</head>
<body style="margin:0;padding:16px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111111;font-size:14px;">
  ${paragraphHtml}
</body>
</html>`;
}

function normalizePlanName(plan: string): string {
  const normalized = plan.trim().toLowerCase();
  if (normalized === "power") return "Power";
  if (normalized === "pro") return "Pro";
  if (normalized === "free") return "Free";
  return normalized.length > 0
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : "Pro";
}

function formatDate(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

export function buildWelcomeEmailTemplate(email: string): EmailTemplate {
  const firstName = resolveFirstName(email);
  const paragraphs = [
    `Hi ${firstName},`,
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
  ];
  return {
    subject: "Welcome to Tallei",
    text: paragraphs.join("\n"),
    html: buildPlainHtml(paragraphs),
  };
}

export function buildPaymentSuccessEmailTemplate(input: PaymentSuccessTemplateInput): EmailTemplate {
  const firstName = resolveFirstName(input.email);
  const planName = normalizePlanName(input.plan);
  const renewalDate = formatDate(input.currentPeriodEnd);
  const renewalLine = renewalDate ? `Your next renewal is scheduled for ${renewalDate}.` : "Your subscription is active.";
  const paragraphs = [
    `Hi ${firstName},`,
    "",
    `Your payment for Tallei ${planName} was successful.`,
    renewalLine,
    "",
    `Manage billing: ${input.manageBillingUrl}`,
    "",
    "Best,",
    "",
    "Team Tallei",
  ];
  return {
    subject: `Payment received - Tallei ${planName}`,
    text: paragraphs.join("\n"),
    html: buildPlainHtml(paragraphs),
  };
}

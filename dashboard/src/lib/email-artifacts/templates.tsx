import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

import type { EmailTemplateId, EmailTemplateProps } from "./types";

export type EmailTemplatePreset = {
  id: EmailTemplateId;
  name: string;
  description: string;
  defaultProps: EmailTemplateProps;
};

export const EMAIL_TEMPLATE_PRESETS: EmailTemplatePreset[] = [
  {
    id: "acknowledgment",
    name: "Acknowledgment",
    description: "Confirm receipt and set expectations.",
    defaultProps: {
      subject: "We received your request",
      previewText: "Thanks for reaching out — we're on it.",
      greeting: "Hi there,",
      body: "Thanks for contacting us. We've received your message and a support agent is reviewing it now. You'll hear back shortly with next steps.",
      signOff: "Best regards,",
      agentName: "Support Team",
    },
  },
  {
    id: "troubleshooting",
    name: "Troubleshooting",
    description: "Share steps to try before escalation.",
    defaultProps: {
      subject: "Let's try these troubleshooting steps",
      previewText: "A few things to check on your side.",
      greeting: "Hi there,",
      body: "Based on what you described, please try the steps below. If the issue persists after trying them, reply to this thread and we'll dig deeper.",
      signOff: "Thanks,",
      agentName: "Support Team",
    },
  },
  {
    id: "escalation",
    name: "Escalation",
    description: "Hand off to a specialist with context.",
    defaultProps: {
      subject: "Your case has been escalated",
      previewText: "A specialist is taking over your request.",
      greeting: "Hi there,",
      body: "Your request needs additional attention, so I've escalated it to a specialist who will follow up with you directly.",
      signOff: "Regards,",
      agentName: "Support Team",
    },
  },
  {
    id: "resolution",
    name: "Resolution",
    description: "Confirm the issue is resolved.",
    defaultProps: {
      subject: "Your issue is resolved",
      previewText: "Closing the loop on your request.",
      greeting: "Hi there,",
      body: "Good news — we've addressed the issue you reported. If anything still looks off, reply here and we'll reopen the case.",
      signOff: "Cheers,",
      agentName: "Support Team",
    },
  },
];

export function LoopEmailTemplate({ props }: { props: EmailTemplateProps }) {
  const agentName = props.agentName?.trim() || "Support Team";
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f8fdf2", fontFamily: "Arial, sans-serif", margin: 0, padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", border: "1px solid #cce89e", margin: "0 auto", maxWidth: "560px", padding: "32px" }}>
          <Section>
            <Heading style={{ color: "#182506", fontSize: "20px", fontWeight: 700, margin: "0 0 16px" }}>
              {props.subject}
            </Heading>
            <Text style={{ color: "#182506", fontSize: "15px", lineHeight: "24px", margin: "0 0 12px" }}>
              {props.greeting}
            </Text>
            <Text style={{ color: "#3d5c18", fontSize: "15px", lineHeight: "24px", margin: "0 0 12px", whiteSpace: "pre-wrap" }}>
              {props.body}
            </Text>
            <Text style={{ color: "#182506", fontSize: "15px", lineHeight: "24px", margin: "16px 0 0" }}>
              {props.signOff}
              <br />
              {agentName}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function presetById(templateId: EmailTemplateId): EmailTemplatePreset | undefined {
  return EMAIL_TEMPLATE_PRESETS.find((preset) => preset.id === templateId);
}

export function parseEmailTemplateProps(source: string): EmailTemplateProps | null {
  try {
    const parsed = JSON.parse(source) as Partial<EmailTemplateProps>;
    return normalizeEmailTemplateProps(parsed);
  } catch {
    return null;
  }
}

export function normalizeEmailTemplateProps(
  partial: Partial<EmailTemplateProps>,
  fallback?: EmailTemplateProps,
): EmailTemplateProps {
  const presetFallback = fallback ?? EMAIL_TEMPLATE_PRESETS[0]!.defaultProps;
  return {
    subject: partial.subject?.trim() || presetFallback.subject,
    previewText: partial.previewText?.trim() || presetFallback.previewText,
    greeting: partial.greeting?.trim() || presetFallback.greeting,
    body: partial.body?.trim() || presetFallback.body,
    signOff: partial.signOff?.trim() || presetFallback.signOff,
    agentName: partial.agentName?.trim() || presetFallback.agentName,
  };
}

export function formatTemplatePreviewText(props: EmailTemplateProps): string {
  const agentName = props.agentName?.trim() || "Support Team";
  return [
    props.greeting,
    "",
    props.body,
    "",
    props.signOff,
    agentName,
  ].join("\n").trim();
}

export function templateTypeLabel(templateId: EmailTemplateId): string {
  if (templateId === "blank") return "Custom";
  return presetById(templateId)?.name ?? templateId;
}

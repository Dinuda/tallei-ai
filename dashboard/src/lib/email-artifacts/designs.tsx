import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import * as React from "react";

import type { EmailDesignId, EmailTemplateProps } from "./types";
import {
  CommunityNotionMagicLinkDesign,
  CommunityStripeWelcomeDesign,
  CommunityVercelInviteDesign,
} from "./community-designs";

function agentName(props: EmailTemplateProps) {
  return props.agentName?.trim() || "Support Team";
}

function MessageBlock({ props }: { props: EmailTemplateProps }) {
  return (
    <>
      <Text style={{ margin: "0 0 12px", lineHeight: "24px" }}>{props.greeting}</Text>
      <Text style={{ margin: "0 0 12px", lineHeight: "24px", whiteSpace: "pre-wrap" }}>{props.body}</Text>
      <Text style={{ margin: "16px 0 0", lineHeight: "24px" }}>
        {props.signOff}
        <br />
        {agentName(props)}
      </Text>
    </>
  );
}

export function MinimalDesign({ props }: { props: EmailTemplateProps }) {
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f8fdf2", fontFamily: "Arial, sans-serif", margin: 0, padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", border: "1px solid #cce89e", margin: "0 auto", maxWidth: "560px", padding: "32px" }}>
          <Heading style={{ color: "#182506", fontSize: "20px", fontWeight: 700, margin: "0 0 16px" }}>{props.subject}</Heading>
          <MessageBlock props={props} />
        </Container>
      </Body>
    </Html>
  );
}

export function VercelInviteDesign({ props }: { props: EmailTemplateProps }) {
  return <CommunityVercelInviteDesign props={props} />;
}

export function StripeReceiptDesign({ props }: { props: EmailTemplateProps }) {
  return <CommunityStripeWelcomeDesign props={props} />;
}

export function NotionMagicLinkDesign({ props }: { props: EmailTemplateProps }) {
  return <CommunityNotionMagicLinkDesign props={props} />;
}

export function LinearWelcomeDesign({ props }: { props: EmailTemplateProps }) {
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f7f8f8", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", margin: 0, padding: "32px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", border: "1px solid #e8e8e8", borderRadius: "12px", margin: "0 auto", maxWidth: "520px", padding: "32px" }}>
          <Heading style={{ color: "#1b1b1b", fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 12px" }}>{props.subject}</Heading>
          <Text style={{ color: "#6b6f76", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }}>{props.previewText}</Text>
          <MessageBlock props={props} />
        </Container>
      </Body>
    </Html>
  );
}

export function AppleReceiptDesign({ props }: { props: EmailTemplateProps }) {
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f5f5f7", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", margin: 0, padding: "32px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", margin: "0 auto", maxWidth: "520px", padding: "36px 32px" }}>
          <Img alt="" height="28" src="https://react.email/static/apple-logo.png" style={{ marginBottom: "24px" }} width="28" />
          <Heading style={{ color: "#1d1d1f", fontSize: "21px", fontWeight: 600, margin: "0 0 20px" }}>{props.subject}</Heading>
          <MessageBlock props={props} />
          <Hr style={{ borderColor: "#d2d2d7", margin: "28px 0 16px" }} />
          <Text style={{ color: "#86868b", fontSize: "12px", lineHeight: "18px", margin: 0 }}>
            This message was sent from your support workflow.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const DESIGN_COMPONENTS: Record<EmailDesignId, React.FC<{ props: EmailTemplateProps }>> = {
  minimal: MinimalDesign,
  "vercel-invite": VercelInviteDesign,
  "stripe-receipt": StripeReceiptDesign,
  "notion-magic-link": NotionMagicLinkDesign,
  "linear-welcome": LinearWelcomeDesign,
  "apple-receipt": AppleReceiptDesign,
};

export function renderDesignComponent(designId: EmailDesignId, props: EmailTemplateProps) {
  const Component = DESIGN_COMPONENTS[designId] ?? MinimalDesign;
  return <Component props={props} />;
}

export function propsToEditorHtml(props: EmailTemplateProps): string {
  const paragraphs = [
    props.greeting,
    ...props.body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean),
    `${props.signOff}\n${agentName(props)}`,
  ];
  return paragraphs.map((part) => `<p>${part.replace(/\n/g, "<br/>")}</p>`).join("\n");
}

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

import type { EmailTemplateProps } from "./types";

/** Static assets vendored from react-email create-email template. */
export const COMMUNITY_EMAIL_STATIC_BASE = "/email-templates";

function agentName(props: EmailTemplateProps) {
  return props.agentName?.trim() || "Support Team";
}

function SupportBody({ props }: { props: EmailTemplateProps }) {
  return (
    <>
      <Text style={{ color: "#333", fontSize: "14px", lineHeight: "24px", margin: "0 0 12px" }}>{props.greeting}</Text>
      <Text style={{ color: "#333", fontSize: "14px", lineHeight: "24px", margin: "0 0 12px", whiteSpace: "pre-wrap" as const }}>{props.body}</Text>
      <Text style={{ color: "#333", fontSize: "14px", lineHeight: "24px", margin: "16px 0 0" }}>
        {props.signOff}
        <br />
        {agentName(props)}
      </Text>
    </>
  );
}

/** Adapted from packages/create-email/template/emails/vercel-invite-user.tsx */
export function CommunityVercelInviteDesign({ props }: { props: EmailTemplateProps }) {
  const baseUrl = COMMUNITY_EMAIL_STATIC_BASE;
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", margin: 0, padding: "24px 0" }}>
        <Container style={{ border: "1px solid #eaeaea", borderRadius: "4px", margin: "0 auto", maxWidth: "465px", padding: "20px" }}>
          <Section style={{ marginTop: "12px", textAlign: "center" as const }}>
            <Img alt="Vercel" height="37" src={`${baseUrl}/static/vercel-logo.png`} style={{ margin: "0 auto" }} width="40" />
          </Section>
          <Heading style={{ color: "#000000", fontSize: "24px", fontWeight: 400, margin: "30px 0 8px", textAlign: "center" as const }}>
            {props.subject}
          </Heading>
          <SupportBody props={props} />
          <Hr style={{ borderColor: "#eaeaea", margin: "26px 0" }} />
          <Text style={{ color: "#666666", fontSize: "12px", lineHeight: "24px", margin: 0 }}>
            This customer reply was drafted from your support workflow.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

/** Adapted from packages/create-email/template/emails/stripe-welcome.tsx */
export function CommunityStripeWelcomeDesign({ props }: { props: EmailTemplateProps }) {
  const baseUrl = COMMUNITY_EMAIL_STATIC_BASE;
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f6f9fc", fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif', margin: 0 }}>
        <Container style={{ backgroundColor: "#ffffff", margin: "0 auto 64px", maxWidth: "520px", padding: "20px 0 48px" }}>
          <Section style={{ padding: "0 48px" }}>
            <Img alt="Stripe" height="21" src={`${baseUrl}/static/stripe-logo.png`} width="49" />
            <Hr style={{ borderColor: "#e6ebf1", margin: "20px 0" }} />
            <Text style={{ color: "#32325d", fontSize: "20px", fontWeight: 600, margin: "0 0 20px" }}>{props.subject}</Text>
            <SupportBody props={props} />
            <Hr style={{ borderColor: "#e6ebf1", margin: "20px 0" }} />
            <Text style={{ color: "#8898aa", fontSize: "12px", lineHeight: "16px", margin: 0 }}>
              Stripe-style receipt layout · React Email community template
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** Adapted from packages/create-email/template/emails/notion-magic-link.tsx */
export function CommunityNotionMagicLinkDesign({ props }: { props: EmailTemplateProps }) {
  const baseUrl = COMMUNITY_EMAIL_STATIC_BASE;
  return (
    <Html>
      <Head />
      {props.previewText ? <Preview>{props.previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", margin: 0 }}>
        <Container style={{ margin: "0 auto", maxWidth: "480px", padding: "12px 24px" }}>
          <Heading style={{ color: "#333", fontSize: "24px", fontWeight: 700, margin: "40px 0 24px" }}>{props.subject}</Heading>
          <Hr style={{ borderColor: "#e9e9e7", margin: "0 0 24px" }} />
          <SupportBody props={props} />
          <Img alt="Notion" height="32" src={`${baseUrl}/static/notion-logo.png`} style={{ marginTop: "24px" }} width="32" />
          <Text style={{ color: "#898989", fontSize: "12px", lineHeight: "22px", margin: "12px 0 24px" }}>
            Notion magic-link layout · React Email community template
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

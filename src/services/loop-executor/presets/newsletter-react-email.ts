/**
 * React Email templates for newsletter broadcasts.
 *
 * @see https://react.email/docs/utilities/render
 * @see https://demo.react.email/preview/01-Barebone/feature-announcement
 * @see https://demo.react.email/preview/02-Matte/feature-announcement
 * @see https://demo.react.email/preview/03-Protocol/feature-announcement
 * @see https://demo.react.email/preview/02-Matte/product-update
 */

import * as React from "react";
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text, render } from "react-email";
import { formatInlineMarkdown } from "./newsletter.js";
import type { NewsletterTemplateId } from "./newsletter.js";

function firstPreviewLine(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim())
    .find((line) => line.length > 0)
    ?.slice(0, 140) ?? "Update from Tallei";
}

type TemplateTheme = {
  accent: string;
  background: string;
  containerBackground: string;
  text: string;
  muted: string;
  border: string;
  radius: string;
  maxWidth: string;
  bodyPadding: string;
  containerPadding: string;
  fontFamily: string;
  buttonBackground: string;
  buttonColor: string;
  headingWeight: string;
  eyebrow: string;
  intro: string;
  footer: string;
};

function themeForTemplate(templateId: NewsletterTemplateId): TemplateTheme { 
   return {
    accent: "#111827",
    background: "#ffffff",
    containerBackground: "#ffffff",
    text: "#111827",
    muted: "#525252",
    border: "#e5e7eb",
    radius: "0",
    maxWidth: "520px",
    bodyPadding: "24px 12px",
    containerPadding: "20px 0 44px",
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
    buttonBackground: "#111827",
    buttonColor: "#ffffff",
    headingWeight: "650",
    eyebrow: "Feature announcement",
    intro: "A quick announcement from Tallei.",
    footer: "You’re receiving this because you subscribed to updates from Tallei.",
  };
}

function markdownHtml(markdown: string, theme: TemplateTheme): string {
  const paragraphStyle = `margin:0 0 16px;font-size:14px;line-height:24px;color:${theme.text};`;
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^[-*_]{3,}$/.test(block.replace(/\s/g, ""))) {
        return '<hr style="border:none;border-top:1px solid #eaeaea;margin:26px 0;" />';
      }
      if (/^#{1,6}\s+/.test(block)) {
        const level = Math.min(3, Math.max(1, block.match(/^#+/)?.[0].length ?? 2));
        const text = formatInlineMarkdown(block.replace(/^#{1,6}\s+/, ""));
        const size = level === 1 ? "20px" : level === 2 ? "18px" : "16px";
        const margin = level === 1 ? "0 0 16px" : "24px 0 12px";
        return `<h${level} style="margin:${margin};font-size:${size};line-height:1.3;color:${theme.text};font-weight:${theme.headingWeight};">${text}</h${level}>`;
      }
      const listItems = block.split("\n").filter((line) => /^[-*]\s+/.test(line.trim()));
      if (listItems.length > 0 && listItems.length === block.split("\n").filter(Boolean).length) {
        return `<ul style="margin:0 0 16px;padding-left:20px;">${listItems.map((line) => `<li style="margin:0 0 8px;font-size:14px;line-height:24px;color:${theme.text};">${formatInlineMarkdown(line.trim().replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p style="${paragraphStyle}">${formatInlineMarkdown(block).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n")
    .replace(/style="color:#2563eb;text-decoration:underline;"/g, `style="color:${theme.accent};text-decoration:underline;"`);
}

function techNewsletterElement(input: {
  subject: string | null;
  markdown: string;
}) {
  const preview = firstPreviewLine(input.markdown);
  const title = input.subject || "Newsletter";
  const theme = themeForTemplate("04-tech-newsletter");

  return React.createElement(
    Html,
    { lang: "en" },
    React.createElement(Head, null),
    React.createElement(Preview, null, preview),
    React.createElement(
      Body,
      {
        style: {
          margin: "0",
          padding: "0",
          backgroundColor: "#f5f5f5",
          fontFamily: theme.fontFamily,
        },
      },
      React.createElement(
        Container,
        {
          style: {
            margin: "0 auto",
            maxWidth: "640px",
            backgroundColor: "#e8e8e8",
            borderRadius: "10px",
          },
        },
        React.createElement("div", {
          style: { padding: "40px 24px" },
          dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, theme) },
        }),
        React.createElement("div", {
          style: { padding: "20px 24px 32px", textAlign: "center" },
        },
          React.createElement(Text, {
            style: { margin: "0", color: "#767676", fontSize: "12px", lineHeight: "18px" },
          }, "Tallei is the AI ring on your finger—easy shopping, clear shipping, and real support when you need it.")
        )
      )
    )
  );
}

function skinNewsletterElement(input: {
  subject: string | null;
  markdown: string;
}) {
  const preview = firstPreviewLine(input.markdown);
  const theme = themeForTemplate("05-skin-newsletter");

  return React.createElement(
    Html,
    { lang: "en" },
    React.createElement(Head, null),
    React.createElement(Preview, null, preview),
    React.createElement(
      Body,
      {
        style: {
          margin: "0",
          padding: "0",
          backgroundColor: "#ffffff",
          fontFamily: theme.fontFamily,
        },
      },
      React.createElement(
        Container,
        {
          style: {
            margin: "0 auto",
            maxWidth: "640px",
            backgroundColor: "#ffffff",
          },
        },
        React.createElement("div", {
          style: { padding: "40px" },
        },
          React.createElement(Heading, {
            as: "h1",
            style: {
              margin: "0 0 32px",
              fontSize: "72px",
              lineHeight: "1",
              color: "#2d2d2d",
              fontWeight: "400",
              textTransform: "capitalize",
            },
          }, "Newsletter"),
          React.createElement("div", {
            dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, theme) },
          })
        )
      )
    )
  );
}

function codepenChallengeElement(input: {
  subject: string | null;
  markdown: string;
}) {
  const preview = firstPreviewLine(input.markdown);
  const title = input.subject || "CodePen Challenge";

  return React.createElement(
    Html,
    { lang: "en" },
    React.createElement(Head, null),
    React.createElement(Preview, null, preview),
    React.createElement(
      Body,
      {
        style: {
          margin: "0",
          padding: "0",
          backgroundColor: "#505050",
          fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
        },
      },
      React.createElement(
        Container,
        {
          style: {
            margin: "0 auto",
            width: "648px",
            maxWidth: "100%",
          },
        },
        React.createElement("div", {
          style: {
            backgroundColor: "#f0d361",
            padding: "30px",
            color: "#191919",
          },
        },
          React.createElement(Text, {
            style: { margin: "0", fontSize: "16px" },
          },
            React.createElement("strong", null, "This week:"),
            " #CodePenChallenge: ",
            React.createElement("span", { style: { fontSize: "32px", marginTop: "4px", marginBottom: "0" } }, title)
          )
        ),
        React.createElement("div", {
          style: {
            margin: "0",
            backgroundColor: "#ffffff",
            padding: "24px",
          },
        },
          React.createElement("div", {
            dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, themeForTemplate("06-codepen-challenge")) },
          })
        )
      )
    )
  );
}

function stackOverflowTipsElement(input: {
  subject: string | null;
  markdown: string;
}) {
  const preview = firstPreviewLine(input.markdown);
  const title = input.subject || "Tips";

  return React.createElement(
    Html,
    { lang: "en" },
    React.createElement(Head, null),
    React.createElement(Preview, null, preview),
    React.createElement(
      Body,
      {
        style: {
          margin: "0",
          padding: "0",
          backgroundColor: "#f3f3f5",
          fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
        },
      },
      React.createElement(
        Container,
        {
          style: {
            width: "680px",
            maxWidth: "100%",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            borderRadius: "4px",
          },
        },
        React.createElement("div", {
          style: {
            backgroundColor: "#2b2d6e",
            padding: "20px 30px",
          },
        },
          React.createElement(Heading, {
            as: "h1",
            style: {
              margin: "0",
              color: "#ffffff",
              fontSize: "27px",
              lineHeight: "27px",
              fontWeight: "700",
            },
          }, "Find what you want, faster"),
          React.createElement(Text, {
            style: {
              margin: "8px 0 0",
              color: "#ffffff",
              fontSize: "17px",
              lineHeight: "24px",
            },
          }, title)
        ),
        React.createElement("div", {
          style: {
            padding: "30px",
          },
        },
          React.createElement("div", {
            dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, themeForTemplate("07-stackoverflow-tips")) },
          })
        )
      )
    )
  );
}

function newsletterEmailElement(input: {
  templateId: NewsletterTemplateId;
  subject: string | null;
  markdown: string;
  eyebrow?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  secondaryUrl?: string;
  footer?: string;
}) {
  if (input.templateId === "04-tech-newsletter") {
    return techNewsletterElement(input);
  }
  if (input.templateId === "05-skin-newsletter") {
    return skinNewsletterElement(input);
  }
  if (input.templateId === "06-codepen-challenge") {
    return codepenChallengeElement(input);
  }
  if (input.templateId === "07-stackoverflow-tips") {
    return stackOverflowTipsElement(input);
  }

  const theme = themeForTemplate(input.templateId);
  const preview = firstPreviewLine(input.markdown);
  const title = input.subject || "Update from Tallei";
  const isBarebone = input.templateId === "01-barebone-feature-announcement";
  const isProductUpdate = input.templateId === "02-matte-product-update";

  return React.createElement(
    Html,
    { lang: "en" },
    React.createElement(Head, null),
    React.createElement(Preview, null, preview),
    React.createElement(
      Body,
      {
        style: {
          margin: "0",
          padding: theme.bodyPadding,
          backgroundColor: theme.background,
          fontFamily: theme.fontFamily,
        },
      },
      React.createElement(
        Container,
        {
          style: {
            margin: "0 auto",
            padding: theme.containerPadding,
            maxWidth: theme.maxWidth,
            backgroundColor: theme.containerBackground,
            border: isBarebone ? "none" : `1px solid ${theme.border}`,
            borderRadius: theme.radius,
          },
        },
        React.createElement(Text, {
          style: {
            margin: "0 0 10px",
            color: theme.accent,
            fontSize: "12px",
            fontWeight: "700",
            letterSpacing: input.templateId === "03-protocol-feature-announcement" ? "0" : "0.05em",
            textTransform: "uppercase",
          },
        }, input.eyebrow ?? theme.eyebrow),
        React.createElement(Heading, {
          as: "h1",
          style: {
            margin: "0 0 12px",
            color: theme.text,
            fontSize: "24px",
            lineHeight: "1.25",
            fontWeight: theme.headingWeight,
          },
        }, title),
        React.createElement(Text, {
          style: {
            margin: "0 0 16px",
            color: theme.muted,
            fontSize: "14px",
            lineHeight: "24px",
          },
        }, `Hi {{{contact.first_name|there}}}, ${theme.intro}`),
        isProductUpdate
          ? React.createElement(Section, {
            style: {
              margin: "22px 0",
              padding: "16px",
              border: `1px solid ${theme.border}`,
              borderRadius: "14px",
              backgroundColor: "#f8fafc",
            },
          },
          React.createElement(Text, {
            style: { margin: "0", color: theme.muted, fontSize: "13px", lineHeight: "21px" },
          }, "Highlights, fixes, and launch notes are grouped below for a quick read.")
          )
          : null,
        React.createElement("div", { dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, theme) } }),
        input.ctaLabel && input.ctaUrl
          ? React.createElement(Section, { style: { margin: "32px 0 24px", textAlign: "center" } },
            React.createElement(Button, {
              href: input.ctaUrl,
              style: {
                backgroundColor: theme.buttonBackground,
                borderRadius: input.templateId === "03-protocol-feature-announcement" ? "4px" : "8px",
                color: theme.buttonColor,
                fontSize: "12px",
                fontWeight: "600",
                lineHeight: "100%",
                textDecoration: "none",
                textAlign: "center",
                display: "inline-block",
                padding: "12px 20px",
              },
            }, input.ctaLabel)
          )
          : null,
        input.secondaryUrl
          ? React.createElement(Text, {
            style: { margin: "0 0 16px", color: theme.muted, fontSize: "14px", lineHeight: "24px" },
          },
            "or copy and paste this URL into your browser:",
            " ",
            React.createElement(Link, { href: input.secondaryUrl, style: { color: theme.accent, textDecoration: "underline" } }, input.secondaryUrl)
          )
          : null,
        React.createElement(Hr, { style: { border: "none", borderTop: `1px solid ${theme.border}`, margin: "26px 0" } }),
        React.createElement(Text, {
          style: { margin: "0 0 8px", color: theme.muted, fontSize: "12px", lineHeight: "22px" },
        }, input.footer ?? theme.footer),
        input.footer
          ? null
          : React.createElement(Text, {
            style: { margin: "0", color: theme.muted, fontSize: "12px", lineHeight: "22px" },
          },
          React.createElement(Link, { href: "{{{RESEND_UNSUBSCRIBE_URL}}}", style: { color: theme.accent, textDecoration: "underline" } }, "Unsubscribe")
          )
      )
    )
  );
}

export async function renderNewsletterReactEmail(input: {
  templateId: NewsletterTemplateId;
  subject: string | null;
  markdown: string;
}) {
  return render(newsletterEmailElement(input), { pretty: true });
}

export async function renderNewsletterReactEmailText(input: {
  templateId: NewsletterTemplateId;
  subject: string | null;
  markdown: string;
}) {
  return render(newsletterEmailElement(input), { plainText: true });
}

export async function renderNewsletterApprovalEmail(input: {
  subject: string;
  markdown: string;
  approvalUrl: string;
  runUrl: string;
}) {
  const element = newsletterEmailElement({
    templateId: "01-barebone-feature-announcement",
    subject: `Approval required: ${input.subject}`,
    markdown: input.markdown,
    eyebrow: "Review before send",
    ctaLabel: "Approve draft",
    ctaUrl: input.approvalUrl,
    secondaryUrl: input.runUrl,
    footer: "This approval request was generated by your Tallei loop. Reply APPROVE to approve or SKIP to skip.",
  });
  const html = await render(element, { pretty: true });
  const text = await render(element, { plainText: true });
  return { html, text };
}

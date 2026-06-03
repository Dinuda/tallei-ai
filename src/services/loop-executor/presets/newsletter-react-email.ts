/**
 * React Email templates for newsletter broadcasts (Vercel invite–style layout).
 *
 * @see https://react.email/docs/utilities/render
 * @see https://demo.react.email/preview/Community/notifications/vercel-invite-user
 */

import * as React from "react";
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text, render } from "react-email";
import { formatInlineMarkdown } from "./newsletter.js";
import type { NewsletterTemplateId } from "./newsletter.js";

function firstPreviewLine(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim())
    .find((line) => line.length > 0)
    ?.slice(0, 140) ?? "Update from Tallei";
}

function markdownHtml(markdown: string, templateId: NewsletterTemplateId): string {
  const accent = templateId === "editorial" ? "#be123c" : "#2563eb";
  const paragraphStyle = "margin:0 0 16px;font-size:14px;line-height:24px;color:#404040;";
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
        return `<h${level} style="margin:${margin};font-size:${size};line-height:1.3;color:#111827;font-weight:600;">${text}</h${level}>`;
      }
      const listItems = block.split("\n").filter((line) => /^[-*]\s+/.test(line.trim()));
      if (listItems.length > 0 && listItems.length === block.split("\n").filter(Boolean).length) {
        return `<ul style="margin:0 0 16px;padding-left:20px;">${listItems.map((line) => `<li style="margin:0 0 8px;font-size:14px;line-height:24px;color:#404040;">${formatInlineMarkdown(line.trim().replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p style="${paragraphStyle}">${formatInlineMarkdown(block).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n")
    .replace(/style="color:#2563eb;text-decoration:underline;"/g, `style="color:${accent};text-decoration:underline;"`);
}

const baseUrl = "https://demo.react.email";
const logoUrl = `${baseUrl}/static/vercel-logo.png`;

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
  const isEditorial = input.templateId === "editorial";
  const accent = isEditorial ? "#be123c" : "#2563eb";
  const preview = firstPreviewLine(input.markdown);
  const title = input.subject || "Update from Tallei";

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
          fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
        },
      },
      React.createElement(
        Container,
        {
          style: {
            margin: "0 auto",
            padding: "20px 0 48px",
            maxWidth: "465px",
          },
        },
        React.createElement(Img, {
          src: logoUrl,
          width: "40",
          height: "37",
          alt: "Tallei",
          style: { margin: "0 0 40px" },
        }),
        React.createElement(Heading, {
          as: "h1",
          style: {
            margin: "0 0 12px",
            color: "#111827",
            fontSize: "24px",
            lineHeight: "1.25",
            fontWeight: "600",
          },
        }, title),
        input.eyebrow
          ? React.createElement(Text, {
            style: {
              margin: "0 0 24px",
              color: accent,
              fontSize: "12px",
              fontWeight: "600",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            },
          }, input.eyebrow)
          : null,
        React.createElement(Text, {
          style: {
            margin: "0 0 16px",
            color: "#404040",
            fontSize: "14px",
            lineHeight: "24px",
          },
        }, "Hi {{{contact.first_name|there}}},"),
        React.createElement("div", { dangerouslySetInnerHTML: { __html: markdownHtml(input.markdown, input.templateId) } }),
        input.ctaLabel && input.ctaUrl
          ? React.createElement(Section, { style: { margin: "32px 0 24px", textAlign: "center" } },
            React.createElement(Button, {
              href: input.ctaUrl,
              style: {
                backgroundColor: "#000000",
                borderRadius: "5px",
                color: "#ffffff",
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
            style: { margin: "0 0 16px", color: "#666666", fontSize: "14px", lineHeight: "24px" },
          },
            "or copy and paste this URL into your browser:",
            " ",
            React.createElement(Link, { href: input.secondaryUrl, style: { color: accent, textDecoration: "underline" } }, input.secondaryUrl)
          )
          : null,
        React.createElement(Hr, { style: { border: "none", borderTop: "1px solid #eaeaea", margin: "26px 0" } }),
        React.createElement(Text, {
          style: { margin: "0 0 8px", color: "#666666", fontSize: "12px", lineHeight: "22px" },
        }, input.footer ?? "You’re receiving this because you subscribed to updates from Tallei."),
        input.footer
          ? null
          : React.createElement(Text, {
            style: { margin: "0", color: "#666666", fontSize: "12px", lineHeight: "22px" },
          },
          React.createElement(Link, { href: "{{{RESEND_UNSUBSCRIBE_URL}}}", style: { color: accent, textDecoration: "underline" } }, "Unsubscribe")
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
    templateId: "clean",
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

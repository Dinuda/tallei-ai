/**
 * presets/newsletter.ts — Newsletter / broadcast workflow preset (opt-in).
 *
 * Provides a fixed multi-agent roster, subscriber-facing email formatting,
 * and CSV recipient parsing. Not imported by the core executor unless presetId is set.
 */

import type { CeoStrategyOutput, DeliveryContentFormatter, LoopPreset } from "../types.js";
import { normalizeRosterAgents } from "../plan.js";

export const NEWSLETTER_DEFAULT_TEMPLATE_ID = "clean";

export const NEWSLETTER_TEMPLATES = [
  {
    id: NEWSLETTER_DEFAULT_TEMPLATE_ID,
    label: "Clean",
    description: "A focused white-card layout for standard product updates.",
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "A warmer publication-style layout with a stronger headline treatment.",
  },
] as const;

export type NewsletterTemplateId = typeof NEWSLETTER_TEMPLATES[number]["id"];

export function listNewsletterTemplates() {
  return NEWSLETTER_TEMPLATES.map((template) => ({ ...template, isDefault: template.id === NEWSLETTER_DEFAULT_TEMPLATE_ID }));
}

export function normalizeNewsletterTemplateId(value: unknown): NewsletterTemplateId {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return NEWSLETTER_TEMPLATES.some((template) => template.id === raw)
    ? raw as NewsletterTemplateId
    : NEWSLETTER_DEFAULT_TEMPLATE_ID;
}

const NEWSLETTER_MEMORY_RECORDS = [
  {
    id: "newsletter-memory-2026-05-26",
    title: "Essential books for product builders",
    summary: "Timeless reading recommendations across writing, execution, strategy, leadership, product craft, and distribution.",
  },
  {
    id: "newsletter-memory-2026-05-25",
    title: "How I AI weekly roundup",
    summary: "Felix Rieseberg's Claude workflows and Google I/O 2026 launch analysis with practical implications for builders.",
  },
];

function buildNewsletterPresetRoster(goal: string): CeoStrategyOutput {
  const memoryContext = NEWSLETTER_MEMORY_RECORDS
    .map((record, index) => `${index + 1}. ${record.title}: ${record.summary}`)
    .join("\n");
  return {
    strategyText: [
      "CEO strategy: run a fixed weekly newsletter pipeline.",
      "Order: Search Agent -> Web Search Agent -> Research Agent -> Writer -> Approval handoff.",
      "Pinned memory records to ground this run:",
      memoryContext,
      "Outcome: publish-ready draft, operator approval, recipient list upload, then broadcast delivery.",
    ].join("\n"),
    agents: normalizeRosterAgents([
      {
        id: "search_agent",
        name: "Search Agent",
        task: [
          "Find timely themes and surface high-signal internal source material.",
          "Output: ranked topic candidates with source notes.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.memory_search" }],
      },
      {
        id: "web_search_agent",
        name: "Web Search Agent",
        task: [
          "Run live web search for priority themes and gather source-grounded evidence.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.web_search", config: { searchContextSize: "high", country: "US" } }],
      },
      {
        id: "research_agent",
        name: "Research Agent",
        task: [
          "Synthesize search outputs into concise research notes for the top topics.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "writer",
        name: "Writer",
        task: [
          "Write only the subscriber-facing newsletter draft using search and research outputs.",
          "Return an optional Subject line followed by the newsletter body.",
          "Do not include workflow headings, draft labels, next steps, approval instructions, publicist handoff notes, or contact-list/upload instructions.",
          "Do not impersonate or sign as a third-party newsletter/person unless the operator explicitly provided that sender identity.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "approval_handoff",
        name: "Approval Handoff",
        task: [
          "Send the final draft to the operator for approval before delivery.",
          "After approval, the operator uploads recipients and the distribution runner sends the broadcast.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.email_approval_request" }],
      },
    ]),
  };
}

function cleanDisplayMarkdown(value: string): string {
  return value
    .trim()
    .replace(/(^|[\s(])(\*\*|__)(?=\S)/g, "$1")
    .replace(/(?<=\S)(\*\*|__)(?=([\s).,!?:;]|$))/g, "");
}

export function extractPrimaryContentFromComments(comments: Array<{ author: string; body: string }>): string {
  const writer = comments.find((c) => /^writer$/i.test(c.author.trim()));
  if (writer?.body?.trim()) return sanitizeSubscriberBody(writer.body);
  const handoff = comments.find((c) => /^(approval_handoff|publicist)$/i.test(c.author.trim()));
  if (handoff?.body?.trim()) return sanitizeSubscriberBody(handoff.body);
  return sanitizeSubscriberBody(comments.at(-1)?.body?.trim() ?? "");
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  }[char] ?? char));
}

export function formatInlineMarkdown(value: string): string {
  const linkTokens: string[] = [];
  const codeTokens: string[] = [];
  const withLinkTokens = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const token = `__MD_LINK_${linkTokens.length}__`;
    linkTokens.push(`<a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(label)}</a>`);
    return token;
  });
  const withCodeTokens = withLinkTokens.replace(/`([^`]+)`/g, (_, content) => {
    const token = `__MD_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code style="background:#f3f4f6;border-radius:6px;padding:1px 6px;color:#111827;">${escapeHtml(content)}</code>`);
    return token;
  });
  let formatted = escapeHtml(withCodeTokens)
    .replace(/(https?:\/\/[^\s<]+)/g, (match) => `<a href="${match}" style="color:#2563eb;text-decoration:underline;">${match}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  for (let index = 0; index < linkTokens.length; index += 1) {
    formatted = formatted.replace(`__MD_LINK_${index}__`, linkTokens[index] ?? "");
  }
  for (let index = 0; index < codeTokens.length; index += 1) {
    formatted = formatted.replace(`__MD_CODE_${index}__`, codeTokens[index] ?? "");
  }
  return formatted;
}

function removeUnsupportedCtaPhrases(value: string): string {
  return value
    .replace(/\s+(?:Read more here|Explore the details)\.?(?=\s|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function sanitizeSubscriberBody(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return "";
  const firstInternalCueIndex = [
    /please review this draft\b/i,
    /let me know if you would like any changes\b/i,
    /approve (?:this|the) draft\b/i,
    /upload a csv\b/i,
    /upload (?:the )?contact list\b/i,
    /contact list upload\b/i,
    /\bprepare it for distribution\b/i,
    /\bonce approved\b/i,
  ]
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const stopPatterns = [
    /^#{1,6}\s*operator approval email\b/im,
    /^#{1,6}\s*approval email\b/im,
    /^#{1,6}\s*next steps\b/im,
    /^#{1,6}\s*internal notes?\b/im,
    /^#{1,6}\s*contact list\b/im,
    /^#{1,6}\s*handoff\b/im,
  ];
  const cutAt = stopPatterns
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const boundary = [cutAt, firstInternalCueIndex]
    .filter((value): value is number => typeof value === "number" && value >= 0)
    .sort((a, b) => a - b)[0];
  const publicSection = (boundary >= 0 ? normalized.slice(0, boundary) : normalized).trim();
  const lines = publicSection.split("\n");
  const cleaned: string[] = [];
  const leakedLennyVoice = /\blenny'?s voice\b/i.test(normalized)
    || /\bdraft newsletter for lenny'?s\b/i.test(normalized)
    || /\blenny'?s weekly product newsletter\b/i.test(normalized);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[?insert .+ here\]?$/i.test(trimmed.replace(/\*/g, ""))) continue;
    if (/^please review\b/i.test(trimmed) && /approve|distribution/i.test(trimmed)) continue;
    if (/^\*{0,2}publicist\*{0,2}\s*:/i.test(trimmed)) continue;
    if (/^\*{0,2}(next steps?|handoff|operator approval|approval request)\*{0,2}\s*:/i.test(trimmed)) continue;
    if (/^would you like\b/i.test(trimmed) && /adjustments?|proceed|next step/i.test(trimmed)) continue;
    if (/^the draft for the weekly product newsletter\b/i.test(trimmed)) continue;
    if (/^draft newsletter in lenny'?s voice\b/i.test(trimmed)) continue;
    if (/^draft newsletter for\b/i.test(trimmed)) continue;
    if (/^#{1,6}\s*(draft newsletter|newsletter draft|draft email)\b/i.test(trimmed)) continue;
    if (/in lenny'?s voice is ready\b/i.test(trimmed)) continue;
    if (leakedLennyVoice && /^lenny\.?$/i.test(trimmed)) {
      if (/^(best|thanks|thank you|cheers),?\s*$/i.test(cleaned.at(-1)?.trim() ?? "")) cleaned.pop();
      continue;
    }
    if (/^here it is:?\s*$/i.test(trimmed)) continue;
    cleaned.push(line);
  }
  return removeUnsupportedCtaPhrases(cleaned.join("\n").replace(/\n\s*---\s*$/g, "").replace(/\n{3,}/g, "\n\n").trim());
}

export function formatNewsletterForEmail(raw: string) {
  const sanitized = sanitizeSubscriberBody(raw);
  const lines = sanitized.split("\n");
  let subject: string | null = null;
  const bodyLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const subjectMatch = trimmed.match(/^(?:\*\*)?subject:?(?:\*\*)?\s*(.+)$/i);
    if (!subject && subjectMatch?.[1]) {
      subject = cleanDisplayMarkdown(subjectMatch[1].replace(/^["']|["']$/g, "").trim());
      continue;
    }
    const boldTitleMatch = trimmed.match(/^\*\*([^*]+)\*\*$/);
    if (!subject && boldTitleMatch?.[1] && bodyLines.length === 0) {
      subject = cleanDisplayMarkdown(boldTitleMatch[1].trim()).slice(0, 160);
      continue;
    }
    if (/^!\[[^\]]*]\([^)]+\)$/.test(trimmed)) continue;
    bodyLines.push(line);
  }
  if (!subject) {
    const titleLineIndex = bodyLines.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !/^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ""));
    });
    if (titleLineIndex >= 0) {
      const titleLine = bodyLines[titleLineIndex]?.trim() ?? "";
      subject = cleanDisplayMarkdown(titleLine
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\*\*([^*]+)\*\*$/, "$1")
        .trim()
      ).slice(0, 160);
      bodyLines.splice(titleLineIndex, 1);
    }
  } else {
    const duplicateTitleIndex = bodyLines.findIndex((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ""))) return false;
      const normalized = cleanDisplayMarkdown(trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\*\*([^*]+)\*\*$/, "$1")
        .trim());
      return normalized.toLowerCase() === subject?.trim().toLowerCase();
    });
    if (duplicateTitleIndex >= 0) bodyLines.splice(duplicateTitleIndex, 1);
  }
  const text = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const htmlBlocks = blocks.map((block) => {
    if (/^[-*_]{3,}$/.test(block.replace(/\s/g, ""))) {
      return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 28px;">';
    }
    if (/^#{1,6}\s+/.test(block)) {
      const markdownLevel = block.match(/^#+/)?.[0].length ?? 2;
      const level = Math.min(3, Math.max(1, markdownLevel));
      const headingText = formatInlineMarkdown(block.replace(/^#{1,6}\s+/, ""));
      if (level === 1) {
        return `<h1 style="margin:0 0 20px;font-size:34px;line-height:1.16;color:#111827;font-weight:800;">${headingText}</h1>`;
      }
      if (level === 2) {
        return `<h2 style="margin:28px 0 14px;font-size:24px;line-height:1.26;color:#111827;font-weight:700;">${headingText}</h2>`;
      }
      return `<h3 style="margin:24px 0 12px;font-size:19px;line-height:1.35;color:#111827;font-weight:700;">${headingText}</h3>`;
    }
    return `<p style="margin:0 0 18px;font-size:20px;line-height:1.68;color:#1f2937;">${formatInlineMarkdown(block).replace(/\n/g, "<br>")}</p>`;
  });
  const html = [
    '<div style="margin:0;padding:28px 0 20px;background:#f8fafc;">',
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Arial,sans-serif;max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">',
    '<div style="padding:32px 34px 34px;">',
    htmlBlocks.join("\n"),
    "</div></div></div>",
  ].join("\n");
  return { subject, text, html };
}

export async function formatNewsletterForBroadcast(
  formatted: { subject?: string | null; text: string; html: string },
  options?: { templateId?: string | null; useReactEmail?: boolean }
) {
  const templateId = normalizeNewsletterTemplateId(options?.templateId);
  if (options?.useReactEmail !== false) {
    const module = await import("./newsletter-react-email.js");
    const renderInput = {
      templateId,
      subject: formatted.subject ?? null,
      markdown: formatted.text,
    };
    const html = await module.renderNewsletterReactEmail(renderInput);
    const text = await module.renderNewsletterReactEmailText(renderInput);
    return { html, text, templateId };
  }
  const html = [
      '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Update from Tallei</div>',
      '<div style="padding:0 8px 18px;font-family:sans-serif;">',
      '<p style="margin:0;font-size:18px;">Hi {{{contact.first_name|there}}},</p>',
      "</div>",
      formatted.html,
      '<p style="font-size:13px;color:#64748b;">You’re receiving this because you subscribed to updates from Tallei.</p>',
      '<p style="font-size:13px;color:#64748b;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>',
    ].join("\n");
  const text = [
    "Hi {{{contact.first_name|there}}},",
    "",
    formatted.text,
    "",
    "You’re receiving this because you subscribed to updates from Tallei.",
    "Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}",
  ].join("\n");
  return { html, text, templateId };
}

/** Parses a CSV/TSV of recipients (email required, name optional). */
export function parseContactListCsv(csv: string) {
  const lines = csv.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const splitRow = (line: string) => {
    if (line.includes(",") && !line.includes("\t")) {
      return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    }
    if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
    if (line.includes(";")) return line.split(";").map((cell) => cell.trim());
    return [line.trim()];
  };
  const header = splitRow(lines[0]).map((cell) => cell.toLowerCase());
  const emailIdx = header.findIndex((cell) => cell === "email" || cell === "email_address");
  const nameIdx = header.findIndex((cell) => cell === "name" || cell === "full_name");
  const dataLines = emailIdx >= 0 ? lines.slice(1) : lines;
  const effectiveEmailIdx = emailIdx >= 0 ? emailIdx : 0;
  const contacts: Array<{ email: string; name?: string }> = [];
  const seen = new Set<string>();
  for (const line of dataLines) {
    const cells = splitRow(line);
    const email = cells[effectiveEmailIdx]?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const name = nameIdx >= 0 ? cells[nameIdx]?.trim() : undefined;
    contacts.push({ email, ...(name ? { name } : {}) });
  }
  if (contacts.length === 0) {
    throw new Error("Recipient list must include at least one valid email address");
  }
  return contacts.slice(0, 5000);
}

export const newsletterDeliveryFormatter: DeliveryContentFormatter = {
  sanitizeBody: sanitizeSubscriberBody,
  formatForDelivery: (raw) => formatNewsletterForEmail(raw),
  formatForBroadcast: (formatted, options) => formatNewsletterForBroadcast(formatted, options),
};

export const newsletterPreset: LoopPreset = {
  id: "newsletter",
  label: "Weekly newsletter with broadcast delivery",
  buildRoster: async (goal) => buildNewsletterPresetRoster(goal),
};

/** @deprecated Use newsletterPreset */
export const extractNewsletterBodyFromComments = extractPrimaryContentFromComments;
/** @deprecated Use sanitizeSubscriberBody */
export const sanitizeSubscriberNewsletterBody = sanitizeSubscriberBody;

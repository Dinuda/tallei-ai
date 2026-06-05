/**
 * presets/newsletter.ts — Newsletter / broadcast workflow preset (opt-in).
 *
 * Provides a fixed multi-agent roster, subscriber-facing email formatting,
 * and CSV recipient parsing. Not imported by the core executor unless presetId is set.
 */

import type { CeoStrategyOutput, DeliveryContentFormatter, LoopPreset } from "../types.js";
import { config } from "../../../config/index.js";
import { normalizeRosterAgents } from "../plan.js";

export const NEWSLETTER_DEFAULT_TEMPLATE_ID = "01-barebone-feature-announcement";

export const NEWSLETTER_TEMPLATES = [
  {
    id: NEWSLETTER_DEFAULT_TEMPLATE_ID,
    label: "Barebone / Feature announcement",
    description: "Minimal single-column feature announcement based on React Email Barebone.",
    previewUrl: "https://demo.react.email/preview/01-Barebone/feature-announcement",
  },
  {
    id: "02-matte-feature-announcement",
    label: "Matte / Feature announcement",
    description: "Soft bordered feature announcement based on React Email Matte.",
    previewUrl: "https://demo.react.email/preview/02-Matte/feature-announcement",
  },
  {
    id: "03-protocol-feature-announcement",
    label: "Protocol / Feature announcement",
    description: "Structured, protocol-style feature announcement based on React Email Protocol.",
    previewUrl: "https://demo.react.email/preview/03-Protocol/feature-announcement",
  },
  {
    id: "02-matte-product-update",
    label: "Matte / Product update",
    description: "Soft product-update layout based on React Email Matte.",
    previewUrl: "https://demo.react.email/preview/02-Matte/product-update",
  },
  {
    id: "04-tech-newsletter",
    label: "Tech / Newsletter",
    description: "Light card layout with spotlight, tips grid, and community CTA.",
    previewUrl: "https://demo.react.email/preview/04-Tech/newsletter",
  },
  {
    id: "05-skin-newsletter",
    label: "Skin / Editorial",
    description: "Editorial serif style with tips, quote, and community section.",
    previewUrl: "https://demo.react.email/preview/05-Skin/newsletter",
  },
  {
    id: "06-codepen-challenge",
    label: "CodePen / Challenge",
    description: "Bold colored challenge format with ideas and resources columns.",
    previewUrl: "https://demo.react.email/preview/06-CodePen/challenge",
  },
  {
    id: "07-stackoverflow-tips",
    label: "Stack Overflow / Tips",
    description: "Professional structured tips format with search guidance.",
    previewUrl: "https://demo.react.email/preview/07-StackOverflow/tips",
  },
] as const;

export type NewsletterTemplateId = typeof NEWSLETTER_TEMPLATES[number]["id"];

export function listNewsletterTemplates() {
  return NEWSLETTER_TEMPLATES.map((template) => ({ ...template, isDefault: template.id === NEWSLETTER_DEFAULT_TEMPLATE_ID }));
}

export function normalizeNewsletterTemplateId(value: unknown): NewsletterTemplateId {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "clean") return "01-barebone-feature-announcement";
  if (raw === "editorial") return "02-matte-feature-announcement";
  return NEWSLETTER_TEMPLATES.some((template) => template.id === raw)
    ? raw as NewsletterTemplateId
    : NEWSLETTER_DEFAULT_TEMPLATE_ID;
}

const NEWSLETTER_MEMORY_RECORDS = [
  {
    id: "newsletter-memory-2026-05-26",
    date: "2026-05-25",
    title: "How I AI: Felix Rieseberg's Claude Cowork workflows + Google I/O 2026 recap",
    url: "https://www.chatprd.ai/how-i-ai/felix-rieseberg-claude-code-cowork-workflows-for-3d-house-design-and-hardware-buddy",
    summary: "Recent Lenny-adjacent coverage focused on practical AI workflows for builders: Claude Cowork usage patterns, personal automation, live dashboards, and Google's latest AI launches with product implications.",
  },
  {
    id: "newsletter-memory-2026-05-31",
    date: "2026-05-31",
    title: "Benedict Evans on AI as a 1997 internet moment",
    url: "https://www.lennysnewsletter.com/p/a-rational-conversation-on-where",
    summary: "Lenny's recent podcast framing centered on where value accrues in AI, why distribution becomes the moat as software gets easier to build, and how to think about tasks versus jobs.",
  },
  {
    id: "newsletter-memory-2026-06-01",
    date: "2026-06-01",
    title: "How I AI: Codex Goals, Claude Opus 4.8, and non-technical app building",
    url: "https://www.chatprd.ai/how-i-ai/codex-goals-claude-opus-4-8-and-non-technical-app-building",
    summary: "Recent coverage emphasized agentic coding workflows, clearer delegation to AI systems, frontier model upgrades, and the widening set of builder tools available to non-technical operators.",
  },
];

const NEWSLETTER_DEV_SOURCE_LINKS = [
  "https://openai.com/index/codex-for-every-role-tool-workflow/",
  "https://openai.com/business/guides-and-resources/how-openai-uses-codex/",
  "https://www.anthropic.com/news/claude-opus-4-8",
  "https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/",
  "https://blog.google/innovation-and-ai/technology/ai/io-2026-google-ai/",
  "https://github.blog/changelog/2026-06-02-expanded-technical-preview-availability-for-the-github-copilot-app/",
  "https://linear.app/changelog/2026-05-27-linear-diffs",
  "https://linear.app/changelog/2026-05-14-code-intelligence",
] as const;

const NEWSLETTER_LIVE_SEARCH_ALLOWED_DOMAINS = [
  "openai.com",
  "anthropic.com",
  "blog.google",
  "github.blog",
  "linear.app",
] as const;

const NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS =
  "Where agentic coding is getting real: what Codex, Claude Opus 4.8, Google's I/O launches, GitHub Copilot app, and Linear's code-aware agent features say about where value is accruing.";

function buildNewsletterSourceAgent(goal: string) {
  if (config.loopExecutorNewsletterLiveWebSearchEnabled) {
    return {
      id: "web_search_agent",
      name: "Web Search Agent",
      task: [
        "Run live web search for the top topic candidates and gather source-grounded evidence from this week's builder/AI news.",
        "Prioritize exact source equivalents to the seeded weekly links and stay focused on recent developments relevant to product builders.",
        `Default topic hypothesis to evaluate: ${NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS}`,
        `Goal: ${goal}`,
      ].join(" "),
      tools: [{
        ref: "internal.web_search",
        config: {
          searchContextSize: "high",
          country: "US",
          allowedDomains: [...NEWSLETTER_LIVE_SEARCH_ALLOWED_DOMAINS],
        },
      }],
    };
  }
  return {
    id: "web_search_agent",
    name: "Seeded Source Agent",
    task: [
      "Development mode: do not call live web search.",
      "Use these exact seeded source links from this week as source candidates.",
      "Produce concise source notes with titles, URLs, likely angles, and what to verify before publishing.",
      `Default topic hypothesis to evaluate: ${NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS}`,
      NEWSLETTER_DEV_SOURCE_LINKS.map((url) => `- ${url}`).join(" "),
      `Goal: ${goal}`,
    ].join(" "),
    tools: [{ ref: "internal.llm_only" }],
  };
}

function buildNewsletterPresetRoster(goal: string): CeoStrategyOutput {
  const memoryContext = NEWSLETTER_MEMORY_RECORDS
    .map((record, index) => `${index + 1}. [${record.date}] ${record.title}\n   URL: ${record.url}\n   Summary: ${record.summary}`)
    .join("\n");
  return {
    strategyText: [
      "CEO strategy: run a fixed weekly newsletter pipeline.",
      "Order: Search Agent -> Web Search Agent -> Research Agent -> Writer -> Approval handoff.",
      "CRITICAL: The Writer MUST check memory for previous newsletters and adopt the same voice, tone, and formatting style.",
      "Pinned memory records to ground this run:",
      memoryContext,
      `Default lead-topic hypothesis to evaluate: ${NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS}`,
      "Outcome: publish-ready draft, operator approval, recipient list upload, then broadcast delivery.",
    ].join("\n"),
    agents: normalizeRosterAgents([
      {
        id: "search_agent",
        name: "Search Agent",
        task: [
          "Search memory for previous newsletters, weekly updates, and product-builder content relevant to Lenny's recent writing.",
          "Fetch every relevant memory about Lenny's Newsletter, including prior issue examples, writing style, voice, formatting, recurring sections, sign-offs, and editorial preferences.",
          "Output: 1) three ranked topic candidates grounded in memory with source notes, 2) a summary of Lenny's recent themes and newsletter voice/style found in memory (tone, formatting, section structure).",
          `Evaluate this hypothesis but do not blindly select it: ${NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS}`,
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{
          ref: "internal.memory_search",
          config: {
            limit: 20,
            query: [
              "Lenny's Newsletter previous issues writing style voice formatting examples",
              "Lenny newsletter memory editorial preferences recurring sections tone sign-off",
              "How I AI Lenny product newsletter product builders style",
            ].join(" "),
          },
        }],
      },
      buildNewsletterSourceAgent(goal),
      {
        id: "research_agent",
        name: "Research Agent",
        task: [
          "Synthesize search outputs into concise research notes for the top topics.",
          "Choose one recommended lead topic, explain why it best matches Lenny's recent direction, and explicitly say why the other candidates were not selected.",
          "Preserve the voice/style summary found by the Search Agent and pass it to the Writer.",
          "Output a concise writer briefing with: selected topic, why now, core arguments, source links to cite, and tone/structure guidance.",
          `Default topic hypothesis to evaluate: ${NEWSLETTER_DEFAULT_TOPIC_HYPOTHESIS}`,
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "writer",
        name: "Writer",
        task: [
          "Write the subscriber-facing newsletter draft using the selected topic and writer briefing from the Research Agent.",
          "FIRST: Review the voice/style summary from the Search Agent. Adopt that exact tone, formatting, and section structure.",
          "If previous newsletters exist in memory, match their voice (casual vs formal, first vs third person, section types, heading style, use of bullet points, etc).",
          "Line 1 must be exactly: Subject: <email subject> (metadata only — never repeat this title in the body).",
          "From line 2 onward: final subscriber-ready sections only.",
          "Do not fall back to a generic weekly roundup or broad link dump; build the piece around the Research Agent's selected lead topic.",
          "Use markdown links for cited sources, keep paragraphs short, and make the final draft read like a finished newsletter from the writer.",
          "Do not include draft labels, approval instructions, publicist handoff notes, or contact-list upload notes.",
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
        tools: [
          { ref: "internal.email_approval_request" },
          { ref: "internal.email_builder_compose" },
          { ref: "internal.email_builder_render" },
        ],
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

function readSubjectMetadataLine(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(?:\*\*|__)?\s*subject\s*:\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?$/i);
  if (!match?.[1]?.trim()) return null;
  return cleanDisplayMarkdown(match[1].replace(/^["']|["']$/g, "").trim()).slice(0, 160);
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
    if (/^here(?:'s| is) (?:the )?(?:final )?(?:newsletter|email|draft)\b/i.test(trimmed)) continue;
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

function normalizeSubjectKey(value: string): string {
  return cleanDisplayMarkdown(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*([^*]+)\*\*$/, "$1")
    .trim()
    .toLowerCase();
}

/** Remove leading markdown blocks that duplicate the email subject (hero H1 renders subject separately). */
export function stripSubjectDuplicateFromMarkdown(markdown: string, subject: string | null | undefined): string {
  const subjectKey = subject?.trim() ? normalizeSubjectKey(subject) : "";
  if (!subjectKey) return markdown.trim();

  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]?.trim()) index += 1;
  if (index >= lines.length) return markdown.trim();

  const firstBlockEnd = (() => {
    for (let i = index + 1; i < lines.length; i += 1) {
      if (!lines[i]?.trim()) return i;
    }
    return lines.length;
  })();
  const firstBlock = lines.slice(index, firstBlockEnd).join("\n").trim();
  const firstLine = lines[index]?.trim() ?? "";
  const firstBlockKey = normalizeSubjectKey(firstBlock.split("\n")[0] ?? firstBlock);
  const firstLineKey = normalizeSubjectKey(firstLine);

  if (firstBlockKey === subjectKey || firstLineKey === subjectKey) {
    let next = firstBlockEnd;
    while (next < lines.length && !lines[next]?.trim()) next += 1;
    return lines.slice(next).join("\n").trim();
  }
  return markdown.trim();
}

export function formatNewsletterForEmail(raw: string) {
  const sanitized = sanitizeSubscriberBody(raw);
  const lines = sanitized.split("\n");
  let subject: string | null = null;
  const bodyLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const subjectLine = readSubjectMetadataLine(trimmed);
    if (subjectLine) {
      subject = subject ?? subjectLine;
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
    for (let index = bodyLines.length - 1; index >= 0; index -= 1) {
      const line = bodyLines[index] ?? "";
      const trimmed = line.trim();
      if (!trimmed || /^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ""))) continue;
      if (readSubjectMetadataLine(trimmed)) {
        bodyLines.splice(index, 1);
        continue;
      }
      const normalized = cleanDisplayMarkdown(trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\*\*([^*]+)\*\*$/, "$1")
        .trim());
      if (normalized.toLowerCase() === subject.trim().toLowerCase()) {
        bodyLines.splice(index, 1);
      }
    }
  }
  let text = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  text = stripSubjectDuplicateFromMarkdown(text, subject);

  // Build Substack-style HTML
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  let inList = false;
  let listBuffer: string[] = [];
  const bodyHtmlParts: string[] = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer.map((item) => {
      const html = formatInlineMarkdown(item.replace(/^[-*]\s+/, ""));
      return `<li style="margin:0 0 10px;font-size:16px;line-height:1.75;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${html}</li>`;
    }).join("");
    bodyHtmlParts.push(`<ul style="margin:0 0 20px;padding-left:20px;">${items}</ul>`);
    listBuffer = [];
    inList = false;
  }

  for (const block of blocks) {
    // Detect italic intro pattern (wrapped in asterisks)
    if (/^\*(?!\*)(.+?)(?<!\*)\*$/.test(block) && !block.includes("\n")) {
      flushList();
      const introText = formatInlineMarkdown(block.replace(/^\*|\*$/g, ""));
      bodyHtmlParts.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#4b5563;font-style:italic;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${introText}</p>`);
      continue;
    }

    // Detect closing sign-off
    if (/^that's all for this week/i.test(block) || /^thanks for reading/i.test(block) || /^see you next/i.test(block)) {
      flushList();
      bodyHtmlParts.push(`<p style="margin:32px 0 0;font-size:16px;line-height:1.75;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${formatInlineMarkdown(block)}</p>`);
      continue;
    }

    // Detect horizontal rule
    if (/^[-*_]{3,}$/.test(block.replace(/\s/g, ""))) {
      flushList();
      bodyHtmlParts.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />');
      continue;
    }

    // Detect headings
    if (/^#{1,6}\s+/.test(block)) {
      flushList();
      const markdownLevel = block.match(/^#+/)?.[0].length ?? 2;
      const level = Math.min(3, Math.max(1, markdownLevel));
      const headingText = formatInlineMarkdown(block.replace(/^#{1,6}\s+/, ""));
      if (level === 1) {
        bodyHtmlParts.push(`<h2 style="margin:32px 0 16px;font-size:28px;line-height:1.3;color:#111827;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${headingText}</h2>`);
      } else if (level === 2) {
        bodyHtmlParts.push(`<h3 style="margin:28px 0 12px;font-size:22px;line-height:1.35;color:#111827;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${headingText}</h3>`);
      } else {
        bodyHtmlParts.push(`<h4 style="margin:20px 0 8px;font-size:17px;line-height:1.4;color:#111827;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${headingText}</h4>`);
      }
      continue;
    }

    // Detect numbered items like "1) Title" or "1. Title"
    const numberedMatch = block.match(/^(\d+[).])\s*(.+)$/);
    if (numberedMatch) {
      flushList();
      const num = numberedMatch[1];
      const rest = numberedMatch[2];
      // Check if there's a bold title within
      const boldTitle = rest.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
      if (boldTitle) {
        bodyHtmlParts.push(`<h4 style="margin:20px 0 8px;font-size:17px;line-height:1.4;color:#111827;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${num} ${formatInlineMarkdown(boldTitle[1])}</h4>`);
        if (boldTitle[2].trim()) {
          bodyHtmlParts.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.75;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${formatInlineMarkdown(boldTitle[2])}</p>`);
        }
      } else {
        bodyHtmlParts.push(`<h4 style="margin:20px 0 8px;font-size:17px;line-height:1.4;color:#111827;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${num} ${formatInlineMarkdown(rest)}</h4>`);
      }
      continue;
    }

    // Detect bullet list items
    const bulletItems = block.split("\n").filter((line) => /^[-*]\s+/.test(line.trim()));
    if (bulletItems.length > 0 && bulletItems.length === block.split("\n").filter(Boolean).length) {
      flushList();
      bulletItems.forEach((item) => listBuffer.push(item));
      inList = true;
      continue;
    }

    // Regular paragraph
    if (inList) {
      listBuffer.push(block);
    } else {
      bodyHtmlParts.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.75;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${formatInlineMarkdown(block).replace(/\n/g, "<br />")}</p>`);
    }
  }
  flushList();

  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>',
    '<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;">',
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#ffffff;">',
    '<tr><td style="padding:24px 20px;">',
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;margin:0 auto;">',
    '<tr><td>',
    // Subscribe forwarding
    '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;text-align:center;line-height:1.4;">Forwarded this email? <a href="{{subscribe_url}}" style="color:#6b7280;text-decoration:underline;">Subscribe here</a> for more</p>',
    // Date
    `<p style="margin:0 0 16px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;line-height:1.4;">${today.toUpperCase()}</p>`,
    // Divider
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0 24px;" />',
    // Body
    bodyHtmlParts.join("\n"),
    // Footer divider
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;" />',
    // Footer
    '<p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6;">You\'re receiving this because you subscribed to updates.</p>',
    '<p style="margin:4px 0 0;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6;"><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a> \u00b7 <a href="{{preferences_url}}" style="color:#6b7280;text-decoration:underline;">Manage preferences</a></p>',
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
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
    const bodyMarkdown = stripSubjectDuplicateFromMarkdown(formatted.text, formatted.subject ?? null);
    const renderInput = {
      templateId,
      subject: formatted.subject ?? null,
      markdown: bodyMarkdown,
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

/** @deprecated Import from csv-parser.ts directly. */
export { parseContactListCsv } from "../csv-parser.js";

export const newsletterDeliveryFormatter: DeliveryContentFormatter = {
  sanitizeBody: sanitizeSubscriberBody,
  formatForDelivery: (raw) => formatNewsletterForEmail(raw),
  formatForBroadcast: (formatted, options) => formatNewsletterForBroadcast(formatted, options),
};

/** Tool refs used by the fixed newsletter roster (for loop allowlists and validation). */
export const NEWSLETTER_PRESET_TOOL_REFS = [
  "internal.memory_search",
  "internal.web_search",
  "internal.llm_only",
  "internal.email_approval_request",
  "internal.email_builder_compose",
  "internal.email_builder_render",
] as const;

export const newsletterPreset: LoopPreset = {
  id: "newsletter",
  label: "Weekly newsletter with broadcast delivery",
  buildRoster: async (goal) => buildNewsletterPresetRoster(goal),
};

/** @deprecated Use newsletterPreset */
export const extractNewsletterBodyFromComments = extractPrimaryContentFromComments;
/** @deprecated Use sanitizeSubscriberBody */
export const sanitizeSubscriberNewsletterBody = sanitizeSubscriberBody;

import { registerDeliveryFormatter } from "../delivery-format.js";
registerDeliveryFormatter("newsletter", newsletterDeliveryFormatter);
registerDeliveryFormatter("newsletter_v1", newsletterDeliveryFormatter);

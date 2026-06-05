export type NewsletterSendMetadata = {
  subject: string | null;
  preview: string | null;
  greeting: string | null;
};

export function parseNewsletterMetadataFromMarkdown(markdown: string): NewsletterSendMetadata {
  const lines = markdown.split("\n");
  let subject = "";
  let preview = "";
  let greeting = "";
  let bodyStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const subjectMatch = trimmed.match(/^Subject:\s*(.+)$/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      continue;
    }

    const previewMatch = trimmed.match(/^Preview:\s*(.+)$/i);
    if (previewMatch) {
      preview = previewMatch[1].trim();
      continue;
    }

    if (!greeting && /^\*.+\*$/.test(trimmed)) {
      greeting = trimmed.replace(/^\*|\*$/g, "").trim();
      continue;
    }

    bodyStarted = true;
    if (!preview && subject) {
      preview = trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .trim()
        .slice(0, 180);
    }
    if (subject && (preview || greeting)) break;
    if (bodyStarted && subject) break;
  }

  return {
    subject: subject || null,
    preview: preview || null,
    greeting: greeting || null,
  };
}

export function extractPreheaderFromHtml(html: string): string | null {
  const match = html.match(/text-preheader[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return null;
  const text = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function extractTitleFromHtml(html: string): string | null {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  return titleMatch?.[1]?.trim() || null;
}

export function resolveNewsletterSendMetadata(input: {
  markdown?: string | null;
  emailTemplate?: {
    subject?: string | null;
    preview?: string | null;
    html?: string | null;
  } | null;
}): NewsletterSendMetadata {
  const fromMarkdown = input.markdown?.trim()
    ? parseNewsletterMetadataFromMarkdown(input.markdown)
    : { subject: null, preview: null, greeting: null };

  const template = input.emailTemplate ?? null;
  const html = template?.html?.trim() ?? null;

  const subject =
    template?.subject?.trim()
    || fromMarkdown.subject
    || (html ? extractTitleFromHtml(html) : null);

  const preview =
    template?.preview?.trim()
    || fromMarkdown.preview
    || (html ? extractPreheaderFromHtml(html) : null);

  return {
    subject: subject || null,
    preview: preview || null,
    greeting: fromMarkdown.greeting || null,
  };
}

export function formatNewsletterMetadataSummary(meta: NewsletterSendMetadata): string | null {
  const parts: string[] = [];
  if (meta.subject) parts.push(`Subject: ${meta.subject}`);
  if (meta.preview) {
    const short = meta.preview.length > 52 ? `${meta.preview.slice(0, 52)}…` : meta.preview;
    parts.push(`Preview: ${short}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

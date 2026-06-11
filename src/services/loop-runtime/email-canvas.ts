import {
  sanitizeEmailMarkdown,
  sanitizeEmailText,
  unwrapEmailMarkdownEnvelope,
} from "../loop-engine/email-output.js";

type UnlayerContent = {
  id: string;
  type: "heading" | "text" | "divider";
  values: Record<string, unknown>;
};

type UnlayerRow = {
  id: string;
  cells: number[];
  columns: Array<{
    id: string;
    contents: UnlayerContent[];
    values: Record<string, unknown>;
  }>;
  values: Record<string, unknown>;
};

export type CanvasEmailDesign = {
  counters: Record<string, number>;
  body: {
    id: string;
    rows: UnlayerRow[];
    values: Record<string, unknown>;
  };
};

export type CanvasEmailTemplate = {
  html: string;
  text: string;
  design: CanvasEmailDesign;
  subject: string;
  preview: string;
  updatedAt: string;
  source: "runtime" | "dashboard";
  finalUse: boolean;
};

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  }[char] ?? char));
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" style="color:#2563eb;text-decoration:underline;">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function readPrefixedLine(line: string, key: "subject" | "preview"): string | null {
  const match = line.trim().match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "i"));
  return match?.[1]?.trim() ? match[1].trim() : null;
}

function parseEmailMarkdown(markdown: string, fallbackSubject?: string | null) {
  const lines = unwrapEmailMarkdownEnvelope(markdown).replace(/\r\n/g, "\n").split("\n");
  let subject = fallbackSubject?.trim() || "";
  let preview = "";
  const bodyLines: string[] = [];

  for (const line of lines) {
    const subjectLine = readPrefixedLine(line, "subject");
    if (subjectLine) {
      subject ||= subjectLine;
      continue;
    }
    const previewLine = readPrefixedLine(line, "preview");
    if (previewLine) {
      preview ||= previewLine;
      continue;
    }
    bodyLines.push(line);
  }

  const body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!subject) {
    const firstContent = body.split("\n").find((line) => line.trim())?.trim() ?? "Email draft";
    subject = firstContent.replace(/^#{1,6}\s+/, "").replace(/^\*\*|\*\*$/g, "").slice(0, 140);
  }
  if (!preview) {
    preview = body.split(/\n\n/)[0]?.replace(/^#{1,6}\s+/, "").slice(0, 180) || subject;
  }
  return { subject, preview, body };
}

function deriveSubjectFromBody(body: string): string {
  const firstContent = body.split("\n").find((line) => line.trim())?.trim() ?? "Email draft";
  return firstContent.replace(/^#{1,6}\s+/, "").replace(/^\*\*|\*\*$/g, "").slice(0, 140);
}

function makeRow(id: string, contents: UnlayerContent[], padding = "0px"): UnlayerRow {
  return {
    id: `row-${id}`,
    cells: [1],
    columns: [{
      id: `col-${id}`,
      contents,
      values: {
        border: {},
        padding: "0px",
        backgroundColor: "",
        _meta: { htmlID: `u_column_${id}`, htmlClassNames: "u_column" },
      },
    }],
    values: {
      columns: false,
      backgroundColor: "#ffffff",
      columnsBackgroundColor: "",
      padding,
      anchor: "",
      hideDesktop: false,
      _meta: { htmlID: `u_row_${id}`, htmlClassNames: "u_row" },
      selectable: true,
      draggable: true,
      duplicatable: true,
      deletable: true,
      hideable: true,
    },
  };
}

function textContent(id: string, html: string, options?: { fontSize?: string; color?: string; align?: string }): UnlayerContent {
  return {
    id,
    type: "text",
    values: {
      containerPadding: "8px 30px",
      fontSize: options?.fontSize ?? "16px",
      color: options?.color ?? "#374151",
      textAlign: options?.align ?? "left",
      lineHeight: "170%",
      text: html,
      linkStyle: { inherit: true, linkColor: "#2563eb", linkUnderline: true },
      _meta: { htmlID: `u_content_${id}`, htmlClassNames: "u_content_text" },
      selectable: true,
      draggable: true,
      duplicatable: true,
      deletable: true,
      hideable: true,
    },
  };
}

function headingContent(id: string, text: string, level: "h1" | "h2" | "h3"): UnlayerContent {
  return {
    id,
    type: "heading",
    values: {
      containerPadding: level === "h1" ? "18px 30px 8px" : "18px 30px 6px",
      headingType: level,
      fontSize: level === "h1" ? "30px" : level === "h2" ? "22px" : "18px",
      fontWeight: level === "h1" ? 800 : 700,
      color: "#111827",
      lineHeight: "130%",
      text,
      _meta: { htmlID: `u_content_${id}`, htmlClassNames: "u_content_heading" },
      selectable: true,
      draggable: true,
      duplicatable: true,
      deletable: true,
      hideable: true,
    },
  };
}

function markdownRows(markdown: string): UnlayerRow[] {
  const rows: UnlayerRow[] = [];
  let textBuffer: string[] = [];
  let rowIndex = 0;

  const flushText = () => {
    const text = textBuffer.join(" ").trim();
    textBuffer = [];
    if (!text) return;
    const id = `body-${rowIndex++}`;
    rows.push(makeRow(id, [
      textContent(`text-${id}`, `<p style="line-height:170%;">${inlineMarkdown(text)}</p>`),
    ]));
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushText();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3";
      const id = `heading-${rowIndex++}`;
      rows.push(makeRow(id, [headingContent(`content-${id}`, escapeHtml(heading[2]), level)]));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushText();
      const id = `bullet-${rowIndex++}`;
      rows.push(makeRow(id, [
        textContent(`text-${id}`, `<p style="line-height:170%;margin:0;">&bull; ${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</p>`),
      ]));
      continue;
    }
    textBuffer.push(line);
  }
  flushText();
  return rows;
}

export function buildCanvasEmailTemplate(input: {
  markdown: string;
  subject?: string | null;
  source?: CanvasEmailTemplate["source"];
  finalUse?: boolean;
}): CanvasEmailTemplate {
  const parsed = parseEmailMarkdown(input.markdown, input.subject);
  const body = sanitizeEmailMarkdown(parsed.body);
  let subject = sanitizeEmailText(parsed.subject);
  let preview = sanitizeEmailText(parsed.preview);
  if (!subject) subject = deriveSubjectFromBody(body);
  if (!preview) {
    preview = body.split(/\n\n/)[0]?.replace(/^#{1,6}\s+/, "").slice(0, 180) || subject;
  }
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  const rows = [
    makeRow("preheader", [
      textContent("text-preheader", `<p style="line-height:140%;">${escapeHtml(preview)}</p>`, {
        fontSize: "13px",
        color: "#6b7280",
        align: "center",
      }),
    ], "8px 0px"),
    makeRow("date", [textContent("text-date", `<p style="line-height:140%;">${today}</p>`, { fontSize: "12px", color: "#9ca3af" })]),
    makeRow("headline", [headingContent("heading-headline", escapeHtml(subject), "h1")]),
    ...markdownRows(body),
  ];
  const design: CanvasEmailDesign = {
    counters: {
      u_row: rows.length,
      u_column: rows.length,
      u_content_text: rows.flatMap((row) => row.columns[0]?.contents ?? []).filter((content) => content.type === "text").length,
      u_content_heading: rows.flatMap((row) => row.columns[0]?.contents ?? []).filter((content) => content.type === "heading").length,
      u_content_divider: 0,
    },
    body: {
      id: "canvas-email-body",
      rows,
      values: {
        backgroundColor: "#ffffff",
        contentWidth: "640px",
        fontFamily: { label: "Arial", value: "arial,helvetica,sans-serif" },
      },
    },
  };
  return {
    design,
    html: renderCanvasEmailHtml(design, subject, preview),
    text: [subject, "", body].join("\n"),
    subject,
    preview,
    updatedAt: new Date().toISOString(),
    source: input.source ?? "runtime",
    finalUse: input.finalUse ?? false,
  };
}

function renderCanvasEmailHtml(design: CanvasEmailDesign, subject: string, preview: string): string {
  const rowHtml = design.body.rows.map((row) => {
    const contents = row.columns[0]?.contents ?? [];
    const inner = contents.map((content) => {
      const values = content.values;
      if (content.type === "heading") {
        const tag = typeof values.headingType === "string" ? values.headingType : "h2";
        return `<${tag} style="margin:0;padding:${values.containerPadding ?? "8px 30px"};font-size:${values.fontSize ?? "22px"};line-height:${values.lineHeight ?? "130%"};color:${values.color ?? "#111827"};font-weight:${values.fontWeight ?? 700};">${values.text ?? ""}</${tag}>`;
      }
      if (content.type === "divider") {
        return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 30px;" />';
      }
      return `<div style="padding:${values.containerPadding ?? "8px 30px"};font-size:${values.fontSize ?? "16px"};line-height:${values.lineHeight ?? "170%"};color:${values.color ?? "#374151"};text-align:${values.textAlign ?? "left"};">${values.text ?? ""}</div>`;
    }).join("\n");
    return `<tr><td style="background:#ffffff;">${inner}</td></tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;">
    <tr><td style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;margin:0 auto;background:#ffffff;">
        ${rowHtml}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

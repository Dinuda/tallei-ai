"use client";

import { forwardRef, useEffect, useRef, useState, type ComponentType } from "react";
import { X, Eye, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

type EmailEditorHandle = {
  editor: {
    exportHtml: (cb: (data: { html: string; design: unknown }) => void) => void;
    loadDesign?: (design: unknown) => void;
  } | null;
};

type EmailDesign = {
  counters: Record<string, number>;
  body: {
    rows: BuilderRow[];
    values: Record<string, unknown>;
  };
};

type BuilderContent = {
  id: string;
  type: "heading" | "text" | "divider";
  values: Record<string, unknown>;
};

type BuilderRow = {
  id: string;
  cells: number[];
  columns: Array<{
    id: string;
    contents: BuilderContent[];
    values: Record<string, unknown>;
  }>;
  values: Record<string, unknown>;
};

const BUILDER_SEED_VERSION = 3;
const UNLAYER_PROJECT_ID = Number.parseInt(process.env.NEXT_PUBLIC_UNLAYER_PROJECT_ID ?? "", 10);

export function EmailBuilderDialog({
  open,
  onClose,
  onSave,
  initialDesign,
  initialHtml,
  initialMarkdown,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (html: string, designJson: unknown) => void;
  initialDesign?: unknown;
  initialHtml?: string;
  initialMarkdown?: string;
}) {
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogHeight, setDialogHeight] = useState(0);
  const editorRef = useRef<EmailEditorHandle>({ editor: null });
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const updateHeight = () => {
      const viewportHeight = window.innerHeight;
      const outerPadding = 32;
      const headerHeight = headerRef.current?.offsetHeight ?? 80;
      setDialogHeight(Math.max(520, viewportHeight - outerPadding - headerHeight));
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, [open]);

  if (!open) return null;

  const handleExport = () => {
    if (!editorRef.current?.editor) return;
    setSaving(true);
    editorRef.current.editor.exportHtml((data) => {
      onSave(data.html, data.design);
      setSaving(false);
      onClose();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div ref={headerRef} className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Email Builder</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
              {ready ? "Ready" : "Loading editor…"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={!ready || saving} onClick={handleExport}>
              {saving ? (
                <>
                  <Save className="size-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Eye className="size-3.5" />
                  Save & Export HTML
                </>
              )}
            </Button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-slate-50">
          <EmailEditorClient
            ref={editorRef}
            height={dialogHeight}
            initialDesign={initialDesign}
            initialHtml={initialHtml}
            initialMarkdown={initialMarkdown}
            onReady={() => setReady(true)}
          />
        </div>
      </div>
    </div>
  );
}

const EmailEditorClient = forwardRef<EmailEditorHandle, {
  height: number;
  initialDesign?: unknown;
  initialHtml?: string;
  initialMarkdown?: string;
  onReady: () => void;
}>(function EmailEditorClient({
  height,
  initialDesign,
  initialHtml,
  initialMarkdown,
  onReady,
}, ref) {
  type EmailEditorComponent = ComponentType<{
    ref: typeof ref;
    minHeight: string | number;
    options: Record<string, unknown>;
    style: Record<string, string>;
    onReady: (editor: EmailEditorHandle["editor"]) => void;
  }>;
  const [ReactEmailEditor, setReactEmailEditor] = useState<EmailEditorComponent | null>(null);

  useEffect(() => {
    let mounted = true;
    void import("react-email-editor").then((module) => {
      if (mounted) setReactEmailEditor(() => module.default as EmailEditorComponent);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!ReactEmailEditor) {
    return <div className="grid h-full place-items-center text-sm text-slate-500">Loading editor...</div>;
  }

  return (
    <div className="h-full w-full overflow-hidden" style={{ height: height > 0 ? `${height}px` : "100%" }}>
      <ReactEmailEditor
        ref={ref}
        minHeight={height > 0 ? height : 520}
        options={{
          displayMode: "email",
          ...(Number.isFinite(UNLAYER_PROJECT_ID) ? { projectId: UNLAYER_PROJECT_ID } : {}),
          defaultDevice: "desktop",
          devices: ["desktop", "mobile"],
          features: {
            textEditor: { spellChecker: true },
            preheaderText: true,
            preview: true,
          },
          tools: {
            form: { enabled: false },
            social: { enabled: true },
          },
        }}
        style={{ height: height > 0 ? `${height}px` : "100%", minHeight: height > 0 ? `${height}px` : "520px", width: "100%" }}
        onReady={(editor) => {
          const design = getLoadableDesign(initialDesign, initialMarkdown, initialHtml);
          if (design && editor?.loadDesign) {
            editor.loadDesign(design);
          }
          onReady();
        }}
      />
    </div>
  );
});

function getLoadableDesign(initialDesign: unknown, initialMarkdown?: string, initialHtml?: string): EmailDesign | unknown | null {
  if (initialDesign && !shouldRegenerateDesign(initialDesign)) return initialDesign;
  return markdownToUnlayerDesign(initialMarkdown) ?? textToUnlayerDesign(extractReadableText(initialHtml));
}

function shouldRegenerateDesign(design: unknown): boolean {
  if (!isRecord(design)) return false;
  const body = isRecord(design.body) ? design.body : null;
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const bodyValues = isRecord(body?.values) ? body.values : {};
  if (bodyValues.talleiBuilderSeedVersion === BUILDER_SEED_VERSION) return false;
  if (rows.length === 0) return false;
  return rows.every((rowItem) => {
    if (!isRecord(rowItem) || typeof rowItem.id !== "string" || !rowItem.id.startsWith("newsletter-row")) return false;
    const columns = Array.isArray(rowItem.columns) ? rowItem.columns : [];
    return columns.every((column) => {
      if (!isRecord(column)) return false;
      const contents = Array.isArray(column.contents) ? column.contents : [];
      return contents.every((content) => isRecord(content) && typeof content.id === "string" && content.id.startsWith("newsletter-"));
    });
  });
}

function markdownToUnlayerDesign(markdown?: string): EmailDesign | null {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) return null;
  return blocksToUnlayerDesign(blocks);
}

function textToUnlayerDesign(text?: string): EmailDesign | null {
  const blocks = parseMarkdownBlocks(text);
  if (blocks.length === 0) return null;
  return blocksToUnlayerDesign(blocks);
}

function blocksToUnlayerDesign(blocks: ContentBlock[]): EmailDesign {
  const rows = blocks.map((block, index) => {
    const contentIndex = index + 1;
    const content = block.kind === "divider"
      ? dividerContent(contentIndex)
      : block.kind === "heading"
        ? headingContent(contentIndex, block.text, block.level)
        : textContent(contentIndex, block.html);
    return row(contentIndex, [content]);
  });
  const headingCount = blocks.filter((block) => block.kind === "heading").length;
  const textCount = blocks.filter((block) => block.kind === "text").length;
  const dividerCount = blocks.filter((block) => block.kind === "divider").length;

  return {
    counters: {
      u_row: rows.length,
      u_column: rows.length,
      u_content_heading: headingCount,
      u_content_text: textCount,
      u_content_divider: dividerCount,
    },
    body: {
      rows,
      values: {
        backgroundColor: "#eef2f7",
        contentWidth: "680px",
        talleiBuilderSeedVersion: BUILDER_SEED_VERSION,
        fontFamily: {
          label: "Arial",
          value: "arial,helvetica,sans-serif",
        },
      },
    },
  };
}

function row(index: number, contents: BuilderContent[]): BuilderRow {
  return {
    id: `newsletter-row-${index}`,
    cells: [1],
    columns: [
      {
        id: `newsletter-column-${index}`,
        contents,
        values: {
          ...editableMeta("column", index),
          backgroundColor: "#ffffff",
          border: {},
          padding: index === 1 ? "30px 32px 8px" : "0px 32px",
          _override: {
            mobile: {
              padding: index === 1 ? "24px 18px 6px" : "0px 18px",
            },
          },
        },
      },
    ],
    values: {
      ...editableMeta("row", index),
      backgroundColor: "#ffffff",
      padding: "0px",
      columnsBackgroundColor: "#ffffff",
      _override: {
        mobile: {
          padding: "0px",
        },
      },
    },
  };
}

type ContentBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "text"; html: string }
  | { kind: "divider" };

function parseMarkdownBlocks(markdown?: string): ContentBlock[] {
  const lines = markdown?.split(/\r?\n/) ?? [];
  const blocks: ContentBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let titleSeen = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "text", html: `<p>${inlineMarkdownToHtml(paragraph.join(" "))}</p>` });
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({
      kind: "text",
      html: `<ul>${listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</ul>`,
    });
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const subject = line.match(/^subject:\s*(.+)$/i);
    if (subject) {
      flushParagraph();
      flushList();
      if (!titleSeen) {
        blocks.push({ kind: "heading", level: 1, text: subject[1].trim() });
        titleSeen = true;
      }
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
        text: stripInlineMarkdown(heading[2]),
      });
      titleSeen = true;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "divider" });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks : [];
}

function headingContent(index: number, text: string, level: 1 | 2 | 3): BuilderContent {
  const fontSize = level === 1 ? "30px" : level === 2 ? "22px" : "18px";
  return {
    id: `newsletter-heading-${index}`,
    type: "heading",
    values: {
      containerPadding: level === 1 ? "10px 10px 18px" : "18px 10px 8px",
      headingType: `h${level}`,
      text: escapeHtml(text),
      fontSize,
      lineHeight: "130%",
      textAlign: "left",
      color: "#0f172a",
      linkStyle: defaultLinkStyle(),
      ...editableMeta("heading", index),
      _override: {
        mobile: {
          fontSize: level === 1 ? "24px" : level === 2 ? "20px" : "17px",
          containerPadding: level === 1 ? "8px 0px 14px" : "14px 0px 6px",
        },
      },
    },
  };
}

function textContent(index: number, html: string): BuilderContent {
  return {
    id: `newsletter-text-${index}`,
    type: "text",
    values: {
      containerPadding: "8px 10px",
      text: html,
      fontSize: "16px",
      lineHeight: "165%",
      textAlign: "left",
      color: "#334155",
      linkStyle: defaultLinkStyle(),
      ...editableMeta("text", index),
      _override: {
        mobile: {
          fontSize: "15px",
          lineHeight: "155%",
          containerPadding: "7px 0px",
        },
      },
    },
  };
}

function dividerContent(index: number): BuilderContent {
  return {
    id: `newsletter-divider-${index}`,
    type: "divider",
    values: {
      containerPadding: "18px 10px",
      width: "100%",
      border: {
        borderTopWidth: "1px",
        borderTopStyle: "solid",
        borderTopColor: "#e2e8f0",
      },
      ...editableMeta("divider", index),
      _override: {
        mobile: {
          containerPadding: "14px 0px",
        },
      },
    },
  };
}

function editableMeta(kind: "row" | "column" | "heading" | "text" | "divider", index: number) {
  const htmlClassNames = kind === "row" ? "u_row" : kind === "column" ? "u_column" : `u_content_${kind}`;
  return {
    anchor: "",
    hideDesktop: false,
    displayCondition: null,
    _meta: {
      htmlID: `${htmlClassNames}_${index}`,
      htmlClassNames,
    },
    selectable: true,
    draggable: true,
    duplicatable: true,
    deletable: true,
    hideable: true,
  };
}

function defaultLinkStyle() {
  return {
    inherit: false,
    linkColor: "#2563eb",
    linkHoverColor: "#1d4ed8",
    linkUnderline: true,
    linkHoverUnderline: true,
  };
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

function extractReadableText(html?: string): string {
  if (!html?.trim()) return "";
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(h1|h2|h3|p|li|div|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h1[^>]*>/gi, "# ")
    .replace(/<h2[^>]*>/gi, "## ")
    .replace(/<h3[^>]*>/gi, "### ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

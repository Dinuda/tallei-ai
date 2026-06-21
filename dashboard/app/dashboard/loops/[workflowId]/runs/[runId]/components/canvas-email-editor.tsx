"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Loader2 } from "lucide-react";

import { EmailArtifactEditorPanel } from "@/components/email-artifact-editor-panel";
import { renderEmailArtifactTemplate } from "@/lib/email-artifacts/build-template";
import {
  canvasEmailSavePayload,
  inferReactEmailSource,
  resolveCanvasEmailEditorContent,
  stripLeadingSubjectFromBody,
  type CanvasEmailTemplateData,
} from "@/lib/email-artifacts/from-canvas-artifact";

export type CanvasEmailTemplate = CanvasEmailTemplateData;

export type CanvasEmailFlushRef = MutableRefObject<(() => Promise<void>) | null>;

function stripSubjectFromEditorHtml(subject: string, html: string): string {
  const subj = subject.trim();
  if (!subj || !html.trim()) return html;
  const escaped = subj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(`^\\s*<p>\\s*${escaped}\\s*</p>\\s*`, "i"), "").trim();
}

function resolveInlineEditorContent(template: CanvasEmailTemplateData): string {
  const subject = template.subject?.trim() ?? "";
  let content = resolveCanvasEmailEditorContent(template);
  if (subject) {
    content = stripSubjectFromEditorHtml(subject, content);
    const plain = stripLeadingSubjectFromBody(subject, content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (plain !== content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) {
      const paragraphs = plain.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
      content = paragraphs.length > 0
        ? paragraphs.map((part) => `<p>${part.replace(/\n/g, "<br/>")}</p>`).join("\n")
        : content;
    }
  }
  return content || "<p></p>";
}

export function CanvasEmailEditor({
  artifactKey,
  template,
  saving,
  onSave,
  hideSaveButton = false,
  flushRef,
  variant = "default",
  onRegisterSave,
}: {
  artifactKey: string;
  template: CanvasEmailTemplate;
  saving: boolean;
  onSave: (input: {
    design: unknown;
    html: string;
    text?: string;
    subject?: string;
    preview?: string;
    reactEmailSource?: string;
    editorContent?: string;
  }) => Promise<void>;
  hideSaveButton?: boolean;
  flushRef?: CanvasEmailFlushRef;
  variant?: "default" | "inline";
  onRegisterSave?: (save: () => Promise<void>) => void;
}) {
  const reactEmailSource = useMemo(() => inferReactEmailSource(template), [template]);
  const initialEditorContent = useMemo(
    () => variant === "inline"
      ? resolveInlineEditorContent(template)
      : resolveCanvasEmailEditorContent(template),
    [template, variant],
  );
  const [editorContent, setEditorContent] = useState(initialEditorContent);
  const subject = template.subject?.trim() || "Email draft";
  const preview = template.preview?.trim() || subject;
  const [rendering, setRendering] = useState(false);
  const exportHtmlRef = useRef<(() => Promise<string>) | null>(null);

  useEffect(() => {
    setEditorContent(variant === "inline"
      ? resolveInlineEditorContent(template)
      : resolveCanvasEmailEditorContent(template));
  }, [template, variant]);

  const save = useCallback(async (html: string) => {
    setRendering(true);
    try {
      const rendered = await renderEmailArtifactTemplate({
        reactEmailSource,
        editorContent: html,
      });
      await onSave(canvasEmailSavePayload({
        template,
        editorContent: html,
        rendered,
        subject,
        preview,
      }));
      setEditorContent(html);
    } finally {
      setRendering(false);
    }
  }, [onSave, preview, reactEmailSource, subject, template]);

  const flushSave = useCallback(async () => {
    const exportHtml = exportHtmlRef.current;
    if (!exportHtml) return;
    const html = await exportHtml();
    if (!html.trim()) return;
    await save(html);
  }, [save]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flushSave;
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, flushSave]);

  useEffect(() => {
    onRegisterSave?.(flushSave);
  }, [flushSave, onRegisterSave]);

  const busy = saving || rendering;

  return (
    <div>
      <EmailArtifactEditorPanel
        content={editorContent}
        editorKey={`${artifactKey}:${initialEditorContent.slice(0, 32)}`}
        exportRef={exportHtmlRef}
        hideSaveButton={hideSaveButton || variant === "inline"}
        onSave={save}
        saving={busy}
        variant={variant}
      />
      {busy ? (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-[#9ca3af]">
          <Loader2 className="size-3.5 animate-spin" />
          Saving…
        </div>
      ) : null}
    </div>
  );
}

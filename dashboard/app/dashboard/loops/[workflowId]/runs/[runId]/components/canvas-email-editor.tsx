"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Loader2 } from "lucide-react";

import { EmailArtifactEditorPanel } from "@/components/email-artifact-editor-panel";
import { renderEmailArtifactTemplate } from "@/lib/email-artifacts/build-template";
import {
  canvasEmailSavePayload,
  inferReactEmailSource,
  resolveCanvasEmailEditorContent,
  type CanvasEmailTemplateData,
} from "@/lib/email-artifacts/from-canvas-artifact";

export type CanvasEmailTemplate = CanvasEmailTemplateData;

export type CanvasEmailFlushRef = MutableRefObject<(() => Promise<void>) | null>;

export function CanvasEmailEditor({
  artifactKey,
  template,
  saving,
  onSave,
  hideSaveButton = false,
  flushRef,
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
}) {
  const reactEmailSource = useMemo(() => inferReactEmailSource(template), [template]);
  const initialEditorContent = useMemo(() => resolveCanvasEmailEditorContent(template), [template]);
  const [editorContent, setEditorContent] = useState(initialEditorContent);
  const [subject, setSubject] = useState(template.subject ?? "Email draft");
  const [preview, setPreview] = useState(template.preview ?? template.subject ?? "");
  const [rendering, setRendering] = useState(false);
  const exportHtmlRef = useRef<(() => Promise<string>) | null>(null);

  useEffect(() => {
    setEditorContent(resolveCanvasEmailEditorContent(template));
    setSubject(template.subject ?? "Email draft");
    setPreview(template.preview ?? template.subject ?? "");
  }, [template]);

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

  const busy = saving || rendering;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-semibold text-slate-700">
          Subject
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="mt-1 w-full border border-[#d1d5db] bg-white px-3 py-2 text-sm font-normal outline-none focus:border-[#9ca3af] focus:ring-2 focus:ring-[#111827]/10"
          />
        </label>
        <label className="text-sm font-semibold text-slate-700">
          Preview
          <input
            value={preview}
            onChange={(event) => setPreview(event.target.value)}
            className="mt-1 w-full border border-[#d1d5db] bg-white px-3 py-2 text-sm font-normal outline-none focus:border-[#9ca3af] focus:ring-2 focus:ring-[#111827]/10"
          />
        </label>
      </div>
      <div className="min-h-[520px]">
        <EmailArtifactEditorPanel
          content={editorContent}
          editorKey={`${artifactKey}:${initialEditorContent.slice(0, 32)}`}
          exportRef={exportHtmlRef}
          hideSaveButton={hideSaveButton}
          onSave={save}
          saving={busy}
          templateName={subject}
        />
      </div>
      {busy ? (
        <div className="flex items-center gap-2 text-[13px] text-[#6b7280]">
          <Loader2 className="size-4 animate-spin" />
          Saving email draft…
        </div>
      ) : null}
    </div>
  );
}

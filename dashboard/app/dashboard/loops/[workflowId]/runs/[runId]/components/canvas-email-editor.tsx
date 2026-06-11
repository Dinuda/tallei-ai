"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";

const EmailEditor = dynamic(() => import("react-email-editor").then((mod) => mod.default), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-[420px] place-items-center rounded-2xl border bg-slate-50 text-sm text-slate-500">
      <Loader2 className="mr-2 inline size-4 animate-spin" />
      Loading email canvas...
    </div>
  ),
}) as ComponentType<Record<string, unknown>>;

type EditorRef = {
  editor?: {
    loadDesign: (design: unknown) => void;
    exportHtml: (callback: (data: { design: unknown; html: string }) => void) => void;
  };
};

export type CanvasEmailTemplate = {
  design: unknown;
  html: string;
  text?: string;
  subject?: string;
  preview?: string;
  updatedAt?: string;
  source?: string;
  finalUse?: boolean;
};

export function CanvasEmailEditor({
  artifactKey,
  template,
  saving,
  onSave,
}: {
  artifactKey: string;
  template: CanvasEmailTemplate;
  saving: boolean;
  onSave: (input: { design: unknown; html: string; text?: string; subject?: string; preview?: string }) => Promise<void>;
}) {
  const editorRef = useRef<EditorRef | null>(null);
  const [ready, setReady] = useState(false);
  const [subject, setSubject] = useState(template.subject ?? "Email draft");
  const [preview, setPreview] = useState(template.preview ?? "");

  useEffect(() => {
    setSubject(template.subject ?? "Email draft");
    setPreview(template.preview ?? "");
    if (ready && template.design) {
      editorRef.current?.editor?.loadDesign(template.design);
    }
  }, [ready, template]);

  const save = async () => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    await new Promise<void>((resolve, reject) => {
      editor.exportHtml((data) => {
        void onSave({
          design: data.design,
          html: data.html,
          text: template.text,
          subject,
          preview,
        }).then(resolve).catch(reject);
      });
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-100 bg-sky-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-sky-700">Canvas email</p>
        <p className="mt-1 text-sm text-slate-600">
          Editing artifact <span className="font-mono">{artifactKey}</span>. Saving creates a new artifact version and does not advance the run.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-semibold text-slate-700">
          Subject
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="mt-1 w-full rounded-xl border px-3 py-2 text-sm font-normal outline-none focus:border-sky-400"
          />
        </label>
        <label className="text-sm font-semibold text-slate-700">
          Preview
          <input
            value={preview}
            onChange={(event) => setPreview(event.target.value)}
            className="mt-1 w-full rounded-xl border px-3 py-2 text-sm font-normal outline-none focus:border-sky-400"
          />
        </label>
      </div>
      <div className="overflow-hidden rounded-2xl border">
        <EmailEditor
          ref={editorRef}
          minHeight="620px"
          onReady={() => {
            setReady(true);
            if (template.design) editorRef.current?.editor?.loadDesign(template.design);
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Last source: {template.source ?? "runtime"}{template.updatedAt ? ` at ${new Date(template.updatedAt).toLocaleString()}` : ""}
        </p>
        <Button onClick={() => void save()} disabled={saving || !ready} className="rounded-lg bg-[#0077b6] font-bold hover:bg-[#00689f]">
          {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
          Save canvas
        </Button>
      </div>
    </div>
  );
}

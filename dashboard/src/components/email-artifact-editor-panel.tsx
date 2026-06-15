"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import "@react-email/editor/themes/default.css";

import type { EmailEditorRef } from "@react-email/editor";

const EmailEditor = dynamic(
  () => import("@react-email/editor").then((mod) => mod.EmailEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[420px] flex-1 items-center justify-center border border-dashed border-[#d1d5db] bg-[#fafafa] text-sm text-[#6b7280]">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        Loading React Email editor…
      </div>
    ),
  },
);

export function EmailArtifactEditorPanel({
  content,
  editorKey,
  onSave,
  onCancel,
  saving,
  templateName,
}: {
  content: string;
  editorKey: string;
  onSave: (html: string) => Promise<void>;
  onCancel?: () => void;
  saving?: boolean;
  templateName?: string;
}) {
  const editorRef = useRef<EmailEditorRef>(null);
  const [ready, setReady] = useState(false);

  const exportHtml = useCallback(async () => {
    if (!editorRef.current) return "";
    return editorRef.current.getEmailHTML();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-sm">
      <div className="flex shrink-0 items-center justify-between border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2.5">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.08em] text-[#6b7280] uppercase">React Email editor</p>
          {templateName ? (
            <p className="text-[13px] font-medium text-[#111827]">{templateName}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <button
              className="rounded-md border border-[#d1d5db] bg-white px-3 py-1.5 text-[12px] text-[#6b7280] hover:bg-[#fafafa]"
              onClick={onCancel}
              type="button"
            >
              Preview
            </button>
          ) : null}
          <button
            className="rounded-md bg-[#111827] px-3 py-1.5 text-[12px] text-white hover:opacity-85 disabled:opacity-50"
            disabled={!ready || saving}
            onClick={() => {
              void exportHtml().then((html) => onSave(html));
            }}
            type="button"
          >
            {saving ? <LoaderCircle className="inline size-3.5 animate-spin" /> : "Save changes"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white p-2 [&_.ProseMirror]:min-h-[360px]">
        <EmailEditor
          content={content}
          key={editorKey}
          onReady={() => setReady(true)}
          ref={editorRef}
          theme="basic"
        />
      </div>
    </div>
  );
}

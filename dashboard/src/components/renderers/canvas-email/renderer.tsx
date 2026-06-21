"use client";

import { useCallback, useRef } from "react";

import type { ArtifactRendererProps } from "../registry";
import {
  EditorialArtifactSaveButton,
  EditorialArtifactTag,
  EditorialPreviewFrame,
  inferArtifactDisplayTitle,
} from "../editorial-artifact-ui";
import { CanvasEmailEditor } from "../../../../app/dashboard/loops/[workflowId]/runs/[runId]/components/canvas-email-editor";
import type { CanvasEmailTemplateData } from "@/lib/email-artifacts/from-canvas-artifact";

type EmailTemplate = CanvasEmailTemplateData;

export function CanvasEmailRenderer({ artifact, saving, onSave, flushRef }: ArtifactRendererProps) {
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const registerSave = useCallback((save: () => Promise<void>) => {
    saveRef.current = save;
  }, []);

  const rawTemplate = artifact.data_json?.emailTemplate as EmailTemplate | undefined;
  const bodyText = artifact.body?.trim() ?? "";
  const template = rawTemplate ? {
    ...rawTemplate,
    html: rawTemplate.html || bodyText,
    text: rawTemplate.text || (bodyText && !bodyText.startsWith("<") ? bodyText : undefined),
    subject: rawTemplate.subject || undefined,
  } : bodyText ? {
    html: bodyText.startsWith("<") ? bodyText : undefined,
    text: bodyText.startsWith("<") ? undefined : bodyText,
    subject: "Email draft",
  } as EmailTemplate : undefined;
  const canvasState = artifact.data_json?.canvas_state as string | undefined;
  const isPreview = canvasState === "preview";
  const displayTitle = inferArtifactDisplayTitle(artifact, "Email");

  if (!template) {
    return (
      <div className="border border-dashed border-[#d1d5db] bg-[#fafafa] px-6 py-10 text-center text-[13px] text-[#9ca3af]">
        No editable email template found in this artifact.
      </div>
    );
  }

  if (isPreview) {
    return (
      <div className="border border-[#d1d5db] bg-white">
        <div className="flex items-center gap-2.5 border-b border-[#e5e7eb] px-4 py-2.5">
          <EditorialArtifactTag tone={template.finalUse ? "green" : "blue"}>
            {template.finalUse ? "Final" : "Ready"}
          </EditorialArtifactTag>
          <p
            className="truncate text-[13px] font-semibold text-[#111827]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            {displayTitle}
          </p>
        </div>
        <EditorialPreviewFrame title="Email preview" className="border-0">
          <iframe
            srcDoc={template.html}
            className="w-full border-0"
            style={{ minHeight: "420px" }}
            sandbox=""
            title="Email preview"
          />
        </EditorialPreviewFrame>
      </div>
    );
  }

  const handleSave = onSave ?? (async () => {});

  return (
    <div className="border border-[#d1d5db] bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-[#e5e7eb] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <EditorialArtifactTag>Email</EditorialArtifactTag>
          <p
            className="truncate text-[13px] font-semibold text-[#111827]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            {displayTitle}
          </p>
        </div>
        <EditorialArtifactSaveButton
          disabled={saving}
          label={saving ? "Saving…" : "Save changes"}
          onClick={() => { void saveRef.current?.(); }}
          saving={saving}
        />
      </div>
      <div className="px-3 py-2">
        <CanvasEmailEditor
          artifactKey={artifact.artifact_key}
          flushRef={flushRef}
          onRegisterSave={registerSave}
          saving={saving}
          template={template}
          variant="inline"
          onSave={handleSave}
        />
      </div>
    </div>
  );
}

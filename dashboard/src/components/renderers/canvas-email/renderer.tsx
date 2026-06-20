"use client";

import type { ArtifactRendererProps } from "../registry";
import {
  EditorialArtifactToolbar,
  EditorialPreviewFrame,
  inferArtifactDisplayTitle,
} from "../editorial-artifact-ui";
import { CanvasEmailEditor } from "../../../../app/dashboard/loops/[workflowId]/runs/[runId]/components/canvas-email-editor";
import type { CanvasEmailTemplateData } from "@/lib/email-artifacts/from-canvas-artifact";

type EmailTemplate = CanvasEmailTemplateData;

export function CanvasEmailRenderer({ artifact, saving, onSave, flushRef }: ArtifactRendererProps) {
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
      <div className="space-y-0">
        <EditorialArtifactToolbar
          tag={template.finalUse ? "Final" : "Ready"}
          title={displayTitle}
          hint="Final preview — approved and ready to send."
        />
        <EditorialPreviewFrame title="Email preview">
          <iframe
            srcDoc={template.html}
            className="w-full border-0"
            style={{ minHeight: "620px" }}
            sandbox=""
            title="Email preview"
          />
        </EditorialPreviewFrame>
      </div>
    );
  }

  const handleSave = onSave ?? (async () => {});

  return (
    <div className="space-y-0">
      <EditorialArtifactToolbar
        tag="Email"
        title={displayTitle}
        hint="Edit the draft in the React Email editor below. Save changes before approving this step."
      />
      <div className="border border-t-0 border-[#d1d5db] bg-white p-6">
        <CanvasEmailEditor
          artifactKey={artifact.artifact_key}
          flushRef={flushRef}
          template={template}
          saving={saving}
          onSave={handleSave}
        />
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ArtifactRendererProps } from "../registry";
import {
  EditorialArtifactToolbar,
  EditorialEditorDialogHeader,
  EditorialOpenEditorButton,
  EditorialPreviewFrame,
  editorialEditorDialogClass,
  inferArtifactDisplayTitle,
} from "../editorial-artifact-ui";
import { CanvasEmailEditor } from "../../../../app/dashboard/loops/[workflowId]/runs/[runId]/components/canvas-email-editor";

type EmailTemplate = {
  design: unknown;
  html: string;
  text?: string;
  subject?: string;
  preview?: string;
  updatedAt?: string;
  source?: string;
};

export function CanvasEmailRenderer({ artifact, saving, onSave }: ArtifactRendererProps) {
  const [open, setOpen] = useState(false);
  const template = artifact.data_json?.emailTemplate as EmailTemplate | undefined;
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
          tag="Ready"
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
        hint="Review the preview below. Open the editor to adjust copy or layout."
        action={<EditorialOpenEditorButton onClick={() => setOpen(true)} />}
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={editorialEditorDialogClass()}>
          <EditorialEditorDialogHeader
            title="Edit email draft"
            description="Adjust subject, body, and layout. Changes save to this run's draft."
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <CanvasEmailEditor
              artifactKey={artifact.artifact_key}
              template={template}
              saving={saving}
              onSave={handleSave}
            />
          </div>
          <DialogFooter showCloseButton className="m-0 rounded-none border-t border-[#e5e7eb] bg-[#fafafa] px-6 py-4" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

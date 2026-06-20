"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { getRenderer, type ArtifactRendererProps, type RendererDef } from "./registry";
import {
  EditorialArtifactToolbar,
  EditorialEditorDialogHeader,
  EditorialOpenEditorButton,
  EditorialPreviewFrame,
  editorialEditorDialogClass,
  inferArtifactDisplayTitle,
} from "./editorial-artifact-ui";

function artifactRendererKey(artifact: ArtifactRendererProps["artifact"]): string {
  const configured = artifact.data_json?.renderTarget ?? artifact.data_json?.renderer;
  return typeof configured === "string" && configured.trim() ? configured.trim() : artifact.kind;
}

export function ArtifactRenderer(props: ArtifactRendererProps) {
  const def = getRenderer(artifactRendererKey(props.artifact));

  if (def?.displayMode === "dialog") {
    return <DialogRenderer def={def} {...props} />;
  }

  if (def) {
    const Comp = def.component;
    return <Comp {...props} />;
  }

  return <DefaultRenderer {...props} />;
}

function DialogRenderer({ def, ...props }: ArtifactRendererProps & { def: RendererDef }) {
  const [open, setOpen] = useState(false);
  const Comp = def.component;
  const displayTitle = inferArtifactDisplayTitle(props.artifact, def.label);

  return (
    <div className="space-y-0">
      <EditorialArtifactToolbar
        tag={def.label}
        title={displayTitle}
        hint="Review the preview below. Open the editor to make changes."
        action={<EditorialOpenEditorButton onClick={() => setOpen(true)} />}
      />
      <EditorialPreviewFrame title={def.label}>
        <iframe
          srcDoc={props.artifact.body}
          className="w-full border-0"
          style={{ minHeight: "620px" }}
          sandbox=""
          title={def.label}
        />
      </EditorialPreviewFrame>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={editorialEditorDialogClass(def.dialogWidth)}>
          <EditorialEditorDialogHeader
            title={`Edit ${def.label.toLowerCase()}`}
            description="Adjust content before approving this step."
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <Comp {...props} />
          </div>
          <DialogFooter showCloseButton className="border-t border-[#e5e7eb] bg-[#fafafa] px-6 py-4" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DefaultRenderer({ artifact }: ArtifactRendererProps) {
  const displayTitle = inferArtifactDisplayTitle(artifact, artifact.kind.replace(/_/g, " "));

  return (
    <div className="space-y-0">
      <EditorialArtifactToolbar tag="Artifact" title={displayTitle} />
      {artifact.body ? (
        <div className="border border-t-0 border-[#d1d5db] bg-white px-6 py-6">
          <div className="prose prose-slate max-w-none text-[16px] leading-7 whitespace-pre-wrap">
            {artifact.body}
          </div>
        </div>
      ) : (
        <div className="grid min-h-[360px] place-items-center border border-t-0 border-dashed border-[#d1d5db] bg-[#fafafa] p-8 text-center text-[13px] text-[#9ca3af]">
          Empty artifact
        </div>
      )}
    </div>
  );
}

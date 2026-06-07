"use client";

import { useState } from "react";
import { Check, PenLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ArtifactRendererProps } from "../registry";
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

  if (!template) {
    return (
      <div className="rounded-2xl border border-dashed bg-slate-50 p-8 text-center text-sm text-slate-500">
        No editable email template found in this artifact.
      </div>
    );
  }

  if (isPreview) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-emerald-700">
            <Check className="size-3" />
            Final preview — this email is ready
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Approved artifact <span className="font-mono">{artifact.artifact_key}</span>.
          </p>
        </div>
        <iframe
          srcDoc={template.html}
          className="w-full rounded-2xl border"
          style={{ minHeight: "620px" }}
          sandbox=""
          title="Email preview"
        />
      </div>
    );
  }

  const handleSave = onSave ?? (async () => {});

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 rounded-2xl border border-sky-100 bg-sky-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-sky-700">Email</p>
          <p className="mt-1 text-sm text-slate-600">
            Artifact <span className="font-mono">{artifact.artifact_key}</span> v{artifact.version}
          </p>
        </div>
        <Button
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-lg bg-[#0077b6] font-bold hover:bg-[#00689f]"
        >
          <PenLine className="mr-2 size-4" />
          Open editor
        </Button>
      </div>
      <iframe
        srcDoc={template.html}
        className="w-full rounded-2xl border"
        style={{ minHeight: "620px" }}
        sandbox=""
        title="Email preview"
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>Email</DialogTitle>
            <DialogDescription>
              Editing <span className="font-mono">{artifact.artifact_key}</span>
            </DialogDescription>
          </DialogHeader>
          <CanvasEmailEditor
            artifactKey={artifact.artifact_key}
            template={template}
            saving={saving}
            onSave={handleSave}
          />
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useState } from "react";
import { PenLine, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getRenderer, type ArtifactRendererProps, type RendererDef } from "./registry";

export function ArtifactRenderer(props: ArtifactRendererProps) {
  const def = getRenderer(props.artifact.kind);

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

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 rounded-2xl border border-sky-100 bg-sky-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-sky-700">{def.label}</p>
          <p className="mt-1 text-sm text-slate-600">
            Artifact <span className="font-mono">{props.artifact.artifact_key}</span> v{props.artifact.version}
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
        srcDoc={props.artifact.body}
        className="w-full rounded-2xl border"
        style={{ minHeight: "620px" }}
        sandbox=""
        title={def.label}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={def.dialogWidth ?? "max-w-[90vw]"}>
          <DialogHeader>
            <DialogTitle>{def.label}</DialogTitle>
            <DialogDescription>
              Editing <span className="font-mono">{props.artifact.artifact_key}</span>
            </DialogDescription>
          </DialogHeader>
          <Comp {...props} />
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DefaultRenderer({ artifact }: ArtifactRendererProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-emerald-700">
          <FileText className="size-3" />
          {artifact.kind}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          Artifact <span className="font-mono">{artifact.artifact_key}</span> v{artifact.version}
        </p>
      </div>
      {artifact.body ? (
        <div className="prose prose-slate max-w-none text-[16px] leading-7 whitespace-pre-wrap">
          {artifact.body}
        </div>
      ) : (
        <div className="grid min-h-[360px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-center text-sm text-slate-500">
          Empty artifact
        </div>
      )}
    </div>
  );
}

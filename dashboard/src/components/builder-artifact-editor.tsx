"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";

import { ArtifactCanvasOverlay } from "@/components/artifact-canvas-overlay";
import { EmailArtifactPreviewCard } from "@/components/email-artifact-preview-card";
import { EmailArtifactStudio, updateArtifactToolOutput } from "@/components/email-artifact-studio";
import type { BuilderDraftTemplate } from "@/lib/email-artifacts/builder-defaults";
import { buildEmailArtifactTemplates, resolveBuilderDraftTemplates } from "@/lib/email-artifacts/build-template";
import { templatesSignature } from "@/lib/email-artifacts/template-signature";
import type {
  ArtifactSetupOutput,
  EmailArtifactTemplate,
  EmailTemplateId,
  EmailTemplateProps,
} from "@/lib/email-artifacts/types";

export type { ArtifactSetupOutput } from "@/lib/email-artifacts/types";
export { updateArtifactToolOutput } from "@/components/email-artifact-studio";

type DraftTemplateInput = {
  templateId: EmailTemplateId;
  name?: string;
  props?: Partial<EmailTemplateProps>;
};

export function BuilderArtifactEditor({
  completedOutput,
  draftTemplates,
  messages,
  onComplete,
  onSave,
  requirementId,
  sessionId,
  toolCallId,
}: {
  completedOutput?: ArtifactSetupOutput | null;
  draftTemplates?: DraftTemplateInput[];
  messages?: UIMessage[];
  onComplete?: (output: ArtifactSetupOutput) => void;
  onSave?: (output: ArtifactSetupOutput) => void;
  requirementId: string;
  sessionId?: string;
  toolCallId?: string;
}) {
  const approved = Boolean(completedOutput);
  const [open, setOpen] = useState(false);
  const [previewTemplates, setPreviewTemplates] = useState<EmailArtifactTemplate[]>(
    () => completedOutput?.templates ?? [],
  );
  const [loadingPreview, setLoadingPreview] = useState(
    () => !completedOutput?.templates?.length,
  );
  const previewSignatureRef = useRef(
    completedOutput?.templates?.length ? templatesSignature(completedOutput.templates) : "",
  );

  const completedSignature = useMemo(
    () => (completedOutput?.templates?.length ? templatesSignature(completedOutput.templates) : null),
    [completedOutput?.templates],
  );

  useEffect(() => {
    if (!completedOutput?.templates?.length || !completedSignature) return;
    if (previewSignatureRef.current === completedSignature) return;
    previewSignatureRef.current = completedSignature;
    setPreviewTemplates(completedOutput.templates);
    setLoadingPreview(false);
  }, [completedOutput?.templates, completedSignature]);

  const handleTemplatesChange = useCallback((templates: EmailArtifactTemplate[]) => {
    const signature = templatesSignature(templates);
    if (previewSignatureRef.current === signature) return;
    previewSignatureRef.current = signature;
    setPreviewTemplates(templates);
    setLoadingPreview(false);
  }, []);

  const draftTemplatesKey = useMemo(
    () => JSON.stringify(resolveBuilderDraftTemplates(draftTemplates as BuilderDraftTemplate[] | undefined)),
    [draftTemplates],
  );

  useEffect(() => {
    if (completedOutput?.templates?.length) return;
    let cancelled = false;
    const drafts = JSON.parse(draftTemplatesKey) as BuilderDraftTemplate[];
    void buildEmailArtifactTemplates(drafts)
      .then((built) => {
        if (cancelled) return;
        handleTemplatesChange(built);
      })
      .catch(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => { cancelled = true; };
  }, [completedOutput?.templates?.length, draftTemplatesKey, handleTemplatesChange]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleComplete = useCallback((output: ArtifactSetupOutput) => {
    setOpen(false);
    onComplete?.(output);
  }, [onComplete]);

  return (
    <>
      <EmailArtifactPreviewCard
        approved={approved}
        loading={loadingPreview && previewTemplates.length === 0}
        onOpen={() => setOpen(true)}
        templates={previewTemplates}
      />
      {open ? (
        <ArtifactCanvasOverlay onClose={handleClose} open title="Reply templates">
          <EmailArtifactStudio
            completedOutput={completedOutput}
            draftTemplates={draftTemplates as BuilderDraftTemplate[] | undefined}
            initialTemplates={previewTemplates}
            key={toolCallId ?? requirementId}
            messages={messages}
            onClose={handleClose}
            onComplete={handleComplete}
            onSave={onSave}
            onTemplatesChange={handleTemplatesChange}
            requirementId={requirementId}
            sessionId={sessionId}
            toolCallId={toolCallId}
          />
        </ArtifactCanvasOverlay>
      ) : null}
    </>
  );
}

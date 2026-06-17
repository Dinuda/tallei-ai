"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";

import { ArtifactCanvasOverlay } from "@/components/artifact-canvas-overlay";
import { EmailArtifactPreviewCard } from "@/components/email-artifact-preview-card";
import { EmailArtifactStudio, updateArtifactToolOutput } from "@/components/email-artifact-studio";
import type { BuilderDraftTemplate } from "@/lib/email-artifacts/builder-defaults";
import { BUILDER_ARTIFACT_DESIGN_ID } from "@/lib/email-artifacts/builder-defaults";
import {
  buildEmailArtifactTemplates,
  draftTemplatesSignature,
  resolveBuilderDraftTemplates,
} from "@/lib/email-artifacts/build-template";
import {
  buildArtifactOutput,
  persistArtifactBundle,
} from "@/lib/email-artifacts/persist";
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
  inputReady = true,
  messages,
  onComplete,
  onSave,
  requirementId,
  sessionId,
  toolCallId,
}: {
  completedOutput?: ArtifactSetupOutput | null;
  draftTemplates?: DraftTemplateInput[];
  inputReady?: boolean;
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
  const [approving, setApproving] = useState(false);
  const previewSignatureRef = useRef(
    completedOutput?.templates?.length ? templatesSignature(completedOutput.templates) : "",
  );
  const lastBuiltDraftSignatureRef = useRef("");

  const completedSignature = useMemo(
    () => (completedOutput?.templates?.length ? templatesSignature(completedOutput.templates) : null),
    [completedOutput?.templates],
  );

  const resolvedDrafts = useMemo(
    () => resolveBuilderDraftTemplates(draftTemplates as BuilderDraftTemplate[] | undefined),
    [draftTemplates],
  );
  const draftSignature = useMemo(
    () => draftTemplatesSignature(resolvedDrafts),
    [resolvedDrafts],
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

  useEffect(() => {
    if (completedOutput?.templates?.length) return;
    if (!inputReady) return;
    if (lastBuiltDraftSignatureRef.current === draftSignature) return;

    let cancelled = false;
    const accumulated: EmailArtifactTemplate[] = [];

    void buildEmailArtifactTemplates(resolvedDrafts, {
      onTemplate: (template, index) => {
        if (cancelled) return;
        accumulated[index] = template;
        setPreviewTemplates(accumulated.filter((entry): entry is EmailArtifactTemplate => Boolean(entry)));
        if (index === 0) setLoadingPreview(false);
      },
    })
      .then((built) => {
        if (cancelled) return;
        lastBuiltDraftSignatureRef.current = draftSignature;
        handleTemplatesChange(built);
      })
      .catch(() => {
        if (!cancelled) setLoadingPreview(false);
      });

    return () => { cancelled = true; };
  }, [
    completedOutput?.templates?.length,
    draftSignature,
    handleTemplatesChange,
    inputReady,
    resolvedDrafts,
  ]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleComplete = useCallback((output: ArtifactSetupOutput) => {
    setOpen(false);
    onComplete?.(output);
  }, [onComplete]);

  const handleProceed = useCallback(async () => {
    if (!onComplete) return;
    setApproving(true);
    try {
      if (previewTemplates.length === 0 || previewTemplates.some((template) => !template.html.trim())) {
        throw new Error("All reply templates must be rendered before proceeding.");
      }
      const output = buildArtifactOutput(previewTemplates, BUILDER_ARTIFACT_DESIGN_ID, requirementId);
      if (sessionId) await persistArtifactBundle(sessionId, output);
      onComplete(output);
    } catch {
      // Studio surfaces errors; inline approve stays silent on failure.
    } finally {
      setApproving(false);
    }
  }, [onComplete, previewTemplates, requirementId, sessionId]);

  return (
    <>
      <EmailArtifactPreviewCard
        approved={approved}
        approving={approving}
        loading={loadingPreview && previewTemplates.length === 0}
        onApprove={onComplete && !approved ? () => void handleProceed() : undefined}
        onOpen={() => setOpen(true)}
        templates={previewTemplates}
      />
      {open ? (
        <ArtifactCanvasOverlay onClose={handleClose} open title="Reply templates">
          <EmailArtifactStudio
            completedOutput={completedOutput}
            draftTemplates={draftTemplates as BuilderDraftTemplate[] | undefined}
            initialTemplates={previewTemplates}
            inputReady={inputReady}
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

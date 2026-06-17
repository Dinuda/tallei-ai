"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Download,
  LoaderCircle,
  X,
} from "lucide-react";
import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";

import { ChatArtifactFloatingBar, ChatArtifactMinimap } from "@/components/chat-artifact-layout";
import { EmailArtifactCanvas } from "@/components/email-artifact-canvas";
import { EmailArtifactEditorPanel } from "@/components/email-artifact-editor-panel";
import { cn } from "@/lib/utils";
import {
  buildEmailArtifactTemplates,
  draftTemplatesSignature,
  renderEmailArtifactTemplate,
  resolveBuilderDraftTemplates,
} from "@/lib/email-artifacts/build-template";
import {
  BUILDER_ARTIFACT_DESIGN_ID,
  type BuilderDraftTemplate,
} from "@/lib/email-artifacts/builder-defaults";
import { copyTemplateBundle, downloadTemplateHtml } from "@/lib/email-artifacts/export";
import {
  buildArtifactOutput,
  persistArtifactBundle,
} from "@/lib/email-artifacts/persist";
import { templatesSignature } from "@/lib/email-artifacts/template-signature";
import { defaultEditorContent } from "@/lib/email-artifacts/render-design";
import type {
  ArtifactSetupOutput,
  EmailArtifactTemplate,
} from "@/lib/email-artifacts/types";

export function updateArtifactToolOutput(
  messages: UIMessage[],
  toolCallId: string,
  output: ArtifactSetupOutput,
): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part) || part.toolCallId !== toolCallId) return part;
      if (getToolName(part) !== "artifactSetup") return part;
      if (part.state !== "output-available") return part;
      return { ...part, output: output as unknown };
    }),
  }));
}

export function EmailArtifactStudio({
  completedOutput,
  draftTemplates,
  initialTemplates,
  inputReady = true,
  messages,
  onClose,
  onComplete,
  onSave,
  onTemplatesChange,
  requirementId,
  sessionId,
  toolCallId,
}: {
  completedOutput?: ArtifactSetupOutput | null;
  draftTemplates?: BuilderDraftTemplate[];
  initialTemplates?: EmailArtifactTemplate[];
  inputReady?: boolean;
  messages?: UIMessage[];
  onClose?: () => void;
  onComplete?: (output: ArtifactSetupOutput) => void;
  onSave?: (output: ArtifactSetupOutput) => void;
  onTemplatesChange?: (templates: EmailArtifactTemplate[]) => void;
  requirementId: string;
  sessionId?: string;
  toolCallId?: string;
}) {
  const approved = Boolean(completedOutput);
  const [templates, setTemplates] = useState<EmailArtifactTemplate[]>(() => initialTemplates ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(
    () => !completedOutput?.templates?.length && initialTemplates === undefined,
  );
  const [rendering, setRendering] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templatesSignatureRef = useRef("");
  const lastBuiltDraftSignatureRef = useRef("");
  const onTemplatesChangeRef = useRef(onTemplatesChange);
  onTemplatesChangeRef.current = onTemplatesChange;

  const notifyTemplatesChange = useCallback((next: EmailArtifactTemplate[]) => {
    const signature = templatesSignature(next);
    if (templatesSignatureRef.current === signature) return;
    templatesSignatureRef.current = signature;
    onTemplatesChangeRef.current?.(next);
  }, []);

  const applyTemplates = useCallback((next: EmailArtifactTemplate[], preferredId?: string | null) => {
    const signature = templatesSignature(next);
    if (templatesSignatureRef.current !== signature) {
      templatesSignatureRef.current = signature;
      setTemplates(next);
    }
    setSelectedId((current) => {
      if (preferredId && next.some((template) => template.id === preferredId)) return preferredId;
      if (current && next.some((template) => template.id === current)) return current;
      return next[0]?.id ?? null;
    });
    setLoading(false);
  }, []);

  const seedDraftsKey = useMemo(
    () => draftTemplatesSignature(draftTemplates),
    [draftTemplates],
  );

  const seedDrafts = useMemo(
    (): BuilderDraftTemplate[] => resolveBuilderDraftTemplates(draftTemplates),
    [draftTemplates],
  );

  const completedTemplates = completedOutput?.templates;
  const completedSignature = useMemo(
    () => (completedTemplates?.length ? templatesSignature(completedTemplates) : null),
    [completedTemplates],
  );

  const selected = templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;
  const editorContent = useMemo(
    () => (selected ? (selected.editorContent ?? defaultEditorContent(selected.reactEmailSource)) : ""),
    [selected],
  );

  const persistOutput = useCallback(async (output: ArtifactSetupOutput) => {
    if (!sessionId) return;
    setPersisting(true);
    setError(null);
    try {
      const nextMessages = messages && toolCallId
        ? updateArtifactToolOutput(messages, toolCallId, output)
        : undefined;
      await persistArtifactBundle(sessionId, output, nextMessages);
      onSave?.(output);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setPersisting(false);
    }
  }, [messages, onSave, sessionId, toolCallId]);

  useEffect(() => {
    if (!completedTemplates?.length || !completedSignature) return;
    if (templatesSignatureRef.current === completedSignature) return;
    const normalized = completedTemplates.map((template) => ({
      ...template,
      designId: BUILDER_ARTIFACT_DESIGN_ID,
    }));
    applyTemplates(normalized);
    notifyTemplatesChange(normalized);
  }, [applyTemplates, completedSignature, completedTemplates, notifyTemplatesChange]);

  useEffect(() => {
    if (completedTemplates?.length || initialTemplates === undefined) return;
    if (initialTemplates.length > 0) {
      applyTemplates(initialTemplates);
    } else {
      setLoading(true);
    }
  }, [applyTemplates, completedTemplates?.length, initialTemplates]);

  useEffect(() => {
    if (completedTemplates?.length || initialTemplates !== undefined) return;
    if (!inputReady) return;
    if (lastBuiltDraftSignatureRef.current === seedDraftsKey) return;

    let cancelled = false;
    const accumulated: EmailArtifactTemplate[] = [];

    void buildEmailArtifactTemplates(seedDrafts, {
      onTemplate: (template, index) => {
        if (cancelled) return;
        accumulated[index] = template;
        const partial = accumulated.filter((entry): entry is EmailArtifactTemplate => Boolean(entry));
        applyTemplates(partial);
        notifyTemplatesChange(partial);
      },
    })
      .then((built) => {
        if (cancelled) return;
        lastBuiltDraftSignatureRef.current = seedDraftsKey;
        applyTemplates(built);
        notifyTemplatesChange(built);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    applyTemplates,
    completedTemplates?.length,
    initialTemplates,
    inputReady,
    notifyTemplatesChange,
    seedDrafts,
    seedDraftsKey,
  ]);

  const saveEditedTemplate = useCallback(async (html: string) => {
    if (!selected) return;
    setRendering(true);
    setError(null);
    try {
      const rendered = await renderEmailArtifactTemplate({
        reactEmailSource: selected.reactEmailSource,
        editorContent: html,
      });
      const updated: EmailArtifactTemplate = {
        ...selected,
        editorContent: html,
        html: rendered.html,
        text: rendered.text,
      };
      const nextTemplates = templates.map((entry) => (entry.id === updated.id ? updated : entry));
      applyTemplates(nextTemplates, updated.id);
      notifyTemplatesChange(nextTemplates);
      const output = buildArtifactOutput(nextTemplates, BUILDER_ARTIFACT_DESIGN_ID, requirementId);
      if (approved || sessionId) {
        await persistOutput(output);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRendering(false);
    }
  }, [applyTemplates, approved, notifyTemplatesChange, persistOutput, requirementId, selected, sessionId, templates]);

  const proceed = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (templates.length === 0 || templates.some((template) => !template.html.trim())) {
        throw new Error("All reply templates must be rendered before proceeding.");
      }
      const output = buildArtifactOutput(templates, BUILDER_ARTIFACT_DESIGN_ID, requirementId);
      if (sessionId) await persistArtifactBundle(sessionId, output);
      onComplete?.(output);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [onComplete, requirementId, sessionId, templates]);

  const minimapItems = templates.map((template) => ({ id: template.id, label: template.name }));

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[#ececec] px-4 py-3">
        <div className="min-w-0">
          <h2
            className="truncate text-[15px] font-semibold text-[#111827]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            Reply templates
          </h2>
          <p className="truncate text-[12px] text-[#9ca3af]">
            {loading
              ? "Drafting…"
              : `${templates.length} emails · minimal design · React Email editor`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {persisting ? (
            <span className="mr-2 inline-flex items-center gap-1 text-[11px] text-[#6b7280]">
              <LoaderCircle className="size-3 animate-spin" />
              Saving…
            </span>
          ) : savedFlash ? (
            <span className="mr-2 inline-flex items-center gap-1 text-[11px] text-[#111827]">
              <Check className="size-3" />
              Saved
            </span>
          ) : null}
          {templates.length > 0 ? (
            <button
              aria-label="Copy all"
              className="inline-flex size-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
              onClick={() => void copyTemplateBundle(templates)}
              title="Copy all"
              type="button"
            >
              <Copy className="size-4" />
            </button>
          ) : null}
          {selected ? (
            <button
              aria-label="Download"
              className="inline-flex size-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
              onClick={() => downloadTemplateHtml(selected)}
              title="Download"
              type="button"
            >
              <Download className="size-4" />
            </button>
          ) : null}
          {onClose ? (
            <button
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
              onClick={onClose}
              title="Close"
              type="button"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      {!loading && templates.length > 0 ? (
        <div className="shrink-0 border-b border-[#ececec] px-4 py-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {templates.map((template) => (
              <button
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                  selected?.id === template.id
                    ? "border-[#111827] bg-[#111827] text-white"
                    : "border-[#e5e5e5] bg-white text-[#6b7280] hover:border-[#9ca3af]",
                )}
                key={template.id}
                onClick={() => {
                  setSelectedId(template.id);
                  setShowPreview(false);
                }}
                type="button"
              >
                {template.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!loading && templates.length > 1 ? (
          <ChatArtifactMinimap
            activeId={selected?.id ?? null}
            items={minimapItems}
            onSelect={(id) => {
              setSelectedId(id);
              setShowPreview(false);
            }}
          />
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pb-28">
          {rendering ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-[13px] text-[#6b7280]">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              Rendering preview…
            </div>
          ) : null}

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-[#6b7280]">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              Drafting reply templates…
            </div>
          ) : selected ? (
            showPreview ? (
              <div className="mx-auto w-full max-w-2xl">
                <EmailArtifactCanvas
                  className="rounded-xl border-[#ececec] shadow-sm"
                  html={selected.html}
                  onClick={() => setShowPreview(false)}
                  subject={selected.subject}
                />
              </div>
            ) : (
              <div className="mx-auto flex h-full min-h-[480px] w-full max-w-3xl flex-col">
                <EmailArtifactEditorPanel
                  content={editorContent}
                  editorKey={selected.id}
                  onCancel={() => setShowPreview(true)}
                  onSave={saveEditedTemplate}
                  saving={rendering}
                  templateName={selected.name}
                />
              </div>
            )
          ) : null}
        </div>
      </div>

      {!loading && selected ? (
        <ChatArtifactFloatingBar>
          <div className="flex items-center gap-2 rounded-full border border-[#e5e5e5] bg-white px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#e5e5e5] px-3 py-1.5 text-[13px] font-medium text-[#111827] hover:bg-[#fafafa]"
              onClick={() => setShowPreview((value) => !value)}
              type="button"
            >
              {showPreview ? "Edit" : "Preview"}
            </button>
            <p className="min-w-0 flex-1 truncate px-1 text-[13px] text-[#9ca3af]">
              {showPreview
                ? `${selected.name} · customer-facing preview`
                : `Editing ${selected.name} · save changes in the editor`}
            </p>
            {!approved ? (
              <button
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[#111827] text-white hover:opacity-90 disabled:opacity-50"
                disabled={submitting}
                onClick={() => void proceed()}
                title="Looks good — proceed"
                type="button"
              >
                {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>
            ) : (
              <span className="inline-flex size-2.5 shrink-0 rounded-full bg-[#7eb71b]" title="Saved" />
            )}
          </div>
        </ChatArtifactFloatingBar>
      ) : null}

      {error ? (
        <p className="shrink-0 border-t border-[#fecaca] bg-[#fef2f2] px-4 py-2.5 text-[12px] text-[#991b1b]">{error}</p>
      ) : null}
    </div>
  );
}

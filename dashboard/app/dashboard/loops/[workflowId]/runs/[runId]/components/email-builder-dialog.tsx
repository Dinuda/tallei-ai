"use client";

import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { X, Eye, Save, PanelLeftClose, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLoadableUnlayerDesign, parseMarkdown } from "@/lib/unlayer-newsletter-template";

type EmailEditorHandle = {
  editor: {
    exportHtml: (cb: (data: { html: string; design: unknown }) => void) => void;
    loadDesign?: (design: unknown) => void;
  } | null;
};

const UNLAYER_PROJECT_ID = Number.parseInt(process.env.NEXT_PUBLIC_UNLAYER_PROJECT_ID ?? "", 10);

export function EmailBuilderDialog({
  open,
  onClose,
  onSave,
  initialDesign,
  initialHtml,
  initialMarkdown,
  initialSubject,
  initialGreeting,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (html: string, designJson: unknown) => void | Promise<void>;
  initialDesign?: unknown;
  initialHtml?: string;
  initialMarkdown?: string;
  initialSubject?: string;
  initialGreeting?: string;
}) {
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editorHeight, setEditorHeight] = useState(600);
  const editorRef = useRef<EmailEditorHandle>({ editor: null });
  const headerRef = useRef<HTMLDivElement>(null);

  // Parse initial values from markdown if not provided explicitly
  const parsed = initialMarkdown ? parseMarkdown(initialMarkdown) : [];
  const parsedSubject = parsed.find((p: { type: string; text?: string }) => p.type === "subject")?.text ?? "";
  const parsedGreeting = parsed.find((p: { type: string; text?: string }) => p.type === "intro")?.text ?? "";

  const [subject, setSubject] = useState(initialSubject ?? parsedSubject ?? "");
  const [headline, setHeadline] = useState(initialSubject ?? parsedSubject ?? "");
  const [greeting, setGreeting] = useState(initialGreeting ?? parsedGreeting ?? "");
  const [applied, setApplied] = useState(false);

  // Measure available height for the editor
  useEffect(() => {
    if (!open) return;
    const updateHeight = () => {
      const headerHeight = headerRef.current?.offsetHeight ?? 72;
      setEditorHeight(Math.max(520, window.innerHeight - 32 - headerHeight));
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, [open]);

  // Reset fields when dialog opens
  useEffect(() => {
    if (!open) return;
    const s = initialSubject ?? parsedSubject ?? "";
    const g = initialGreeting ?? parsedGreeting ?? "";
    setSubject(s);
    setHeadline(s);
    setGreeting(g);
    setApplied(false);
  }, [open, initialSubject, initialGreeting, parsedSubject, parsedGreeting]);

  const handleApply = useCallback(() => {
    if (!editorRef.current?.editor?.loadDesign) return;
    const design = getLoadableUnlayerDesign(initialDesign, initialMarkdown, initialHtml, {
      subject: headline || subject,
      greeting,
    });
    if (design) {
      editorRef.current.editor.loadDesign(design);
      setApplied(true);
      window.setTimeout(() => setApplied(false), 1500);
    }
  }, [initialDesign, initialHtml, initialMarkdown, headline, subject, greeting]);

  const handleExport = () => {
    if (!editorRef.current?.editor) return;
    setSaving(true);
    editorRef.current.editor.exportHtml((data) => {
      void Promise.resolve(onSave(data.html, data.design))
        .then(() => {
          onClose();
        })
        .catch(() => undefined)
        .finally(() => {
          setSaving(false);
        });
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        {/* Top header */}
        <div ref={headerRef} className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Email Builder</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
              {ready ? "Ready" : "Loading editor…"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <PanelLeftClose className="size-3.5" /> : <PanelLeft className="size-3.5" />}
              {sidebarOpen ? "Hide panel" : "Show panel"}
            </Button>
            <Button type="button" size="sm" disabled={!ready || saving} onClick={handleExport}>
              {saving ? (
                <>
                  <Save className="size-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Eye className="size-3.5" />
                  Save & Export HTML
                </>
              )}
            </Button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Main content: sidebar + editor */}
        <div className="min-h-0 flex-1 overflow-hidden bg-slate-50">
          <div className="flex h-full">
            {/* Left sidebar with meta fields */}
            {sidebarOpen && (
              <div className="h-full w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-5">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Newsletter metadata</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Edit these fields then click Apply to update the template.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label htmlFor="eb-subject" className="mb-1 block text-xs font-medium text-slate-700">
                        Email subject
                      </label>
                      <input
                        id="eb-subject"
                        type="text"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="e.g. What I Read This Week"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      />
                    </div>

                    <div>
                      <label htmlFor="eb-headline" className="mb-1 block text-xs font-medium text-slate-700">
                        Headline (visible in email)
                      </label>
                      <input
                        id="eb-headline"
                        type="text"
                        value={headline}
                        onChange={(e) => setHeadline(e.target.value)}
                        placeholder="Defaults to subject"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      />
                    </div>

                    <div>
                      <label htmlFor="eb-greeting" className="mb-1 block text-xs font-medium text-slate-700">
                        Greeting / intro
                      </label>
                      <textarea
                        id="eb-greeting"
                        value={greeting}
                        onChange={(e) => setGreeting(e.target.value)}
                        placeholder="e.g. What I Read This Week: a summary..."
                        rows={3}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 resize-none"
                      />
                    </div>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    onClick={handleApply}
                    disabled={!ready}
                  >
                    {applied ? "Applied!" : "Apply to template"}
                  </Button>

                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      You can also edit text directly in the canvas. Bold headings, story items, and the closing sign-off will auto-populate from the Writer&apos;s markdown.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Editor */}
            <div className="min-h-0 flex-1">
              <EmailEditorClient
                ref={editorRef}
                editorHeight={editorHeight}
                initialDesign={initialDesign}
                initialHtml={initialHtml}
                initialMarkdown={initialMarkdown}
                options={{ subject: headline || subject, greeting }}
                onReady={() => setReady(true)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const EmailEditorClient = forwardRef<EmailEditorHandle, {
  editorHeight: number;
  initialDesign?: unknown;
  initialHtml?: string;
  initialMarkdown?: string;
  options?: { subject?: string; greeting?: string };
  onReady: () => void;
}>(function EmailEditorClient({
  editorHeight,
  initialDesign,
  initialHtml,
  initialMarkdown,
  options,
  onReady,
}, ref) {
  type EmailEditorComponent = ComponentType<{
    ref: typeof ref;
    minHeight: string | number;
    options: Record<string, unknown>;
    style: Record<string, string>;
    onReady: (editor: EmailEditorHandle["editor"]) => void;
  }>;
  const [ReactEmailEditor, setReactEmailEditor] = useState<EmailEditorComponent | null>(null);

  useEffect(() => {
    let mounted = true;
    void import("react-email-editor").then((module) => {
      if (mounted) setReactEmailEditor(() => module.default as EmailEditorComponent);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!ReactEmailEditor) {
    return <div className="grid h-full place-items-center text-sm text-slate-500">Loading editor...</div>;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ReactEmailEditor
        ref={ref}
        minHeight={editorHeight}
        options={{
          displayMode: "email",
          ...(Number.isFinite(UNLAYER_PROJECT_ID) ? { projectId: UNLAYER_PROJECT_ID } : {}),
          defaultDevice: "desktop",
          devices: ["desktop", "mobile"],
          features: {
            textEditor: { spellChecker: true },
            preheaderText: true,
            preview: true,
          },
          tools: {
            form: { enabled: false },
            social: { enabled: true },
          },
        }}
        style={{ position: "absolute", top: "0", left: "0", width: "100%", height: `${editorHeight}px`, minHeight: `${editorHeight}px` }}
        onReady={(editor) => {
          const design = getLoadableUnlayerDesign(initialDesign, initialMarkdown, initialHtml, options);
          if (design && editor?.loadDesign) {
            editor.loadDesign(design);
          }
          onReady();
        }}
      />
    </div>
  );
});
"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FileText, X, Check, Upload, Sparkles, Loader2 } from "lucide-react";

import styles from "./page.module.css";

type FirstActor = "chatgpt" | "claude";

type ContextDocument = {
  ref: string;
  label: string;
  snippet: string;
  source: "uploaded" | "existing";
};

type ExistingDocListItem = {
  ref: string;
  filename: string | null;
  title: string | null;
  preview: string;
};

const STEPS = [
  { id: 0, label: "Scope", description: "What should ChatGPT and Claude work on?" },
  { id: 1, label: "Roles", description: "Define each provider's focus." },
  { id: 2, label: "Review", description: "Confirm and create the task." },
];

const DEFAULT_CHATGPT_ROLE = "Explore alternatives, expand options, and draft creative first-pass outputs.";
const DEFAULT_CLAUDE_ROLE = "Stress-test assumptions, tighten technical details, and finalize implementation-ready output.";

function suggestRolesFromPrompt(input: { title: string; brief: string }): {
  chatgptRole: string;
  claudeRole: string;
  starter: FirstActor;
} {
  const text = `${input.title} ${input.brief}`.toLowerCase();
  const technicalHint = /(api|schema|db|database|migration|backend|auth|infra|typescript|test|contract|route|architecture)/.test(text);
  return {
    chatgptRole: DEFAULT_CHATGPT_ROLE,
    claudeRole: DEFAULT_CLAUDE_ROLE,
    starter: technicalHint ? "claude" : "chatgpt",
  };
}

export default function CollabTaskWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [roleLoading, setRoleLoading] = useState(false);
  const [stepWaiting, setStepWaiting] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [chatgptRole, setChatgptRole] = useState("");
  const [claudeRole, setClaudeRole] = useState("");
  const [starterRecommendation, setStarterRecommendation] = useState<FirstActor>("chatgpt");
  const [grillMeEnabled, setGrillMeEnabled] = useState(false);
  const [grillMeRecommendation, setGrillMeRecommendation] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [contextDocs, setContextDocs] = useState<ContextDocument[]>([]);
  const [existingDocs, setExistingDocs] = useState<ExistingDocListItem[]>([]);
  const [selectedExistingRefs, setSelectedExistingRefs] = useState<string[]>([]);
  const [docSearch, setDocSearch] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canContinue = useMemo(() => {
    if (step === 0) return title.trim().length > 0;
    if (step === 1) return chatgptRole.trim().length > 0 && claudeRole.trim().length > 0;
    return true;
  }, [step, title, chatgptRole, claudeRole]);

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    setPendingFiles((current) => {
      const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      const next = [...current];
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          next.push(file);
          seen.add(key);
        }
      }
      return next;
    });

    event.target.value = "";
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((current) => current.filter((_, idx) => idx !== index));
  };

  const loadDocumentSnippet = async (ref: string): Promise<string> => {
    try {
      const detailRes = await fetch(`/api/documents/${encodeURIComponent(ref)}`, { cache: "no-store" });
      const detailBody = await detailRes.json();
      if (!detailRes.ok) return "";
      if (typeof detailBody?.content === "string" && detailBody.content.trim()) {
        return detailBody.content.trim().slice(0, 700);
      }
      return "";
    } catch {
      return "";
    }
  };

  const loadExistingDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const res = await fetch("/api/documents", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Failed to load documents");

      const docs = Array.isArray(body?.docs)
        ? body.docs
            .filter((item: unknown): item is ExistingDocListItem => { const rec = item as Record<string, unknown>; return Boolean(rec && typeof rec === "object" && typeof rec.ref === "string"); })
            .slice(0, 100)
        : [];
      setExistingDocs(docs);
    } catch {
      setExistingDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  const prepareContextDocs = async (): Promise<ContextDocument[]> => {
    const uploadedDocs: ContextDocument[] = [];

    for (const file of pendingFiles) {
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("mode", "note");
      formData.append("title", file.name);

      try {
        const uploadRes = await fetch("/api/documents", { method: "POST", body: formData });
        const uploadBody = await uploadRes.json();
        if (!uploadRes.ok || typeof uploadBody?.ref !== "string") continue;

        const snippet = await loadDocumentSnippet(uploadBody.ref);
        uploadedDocs.push({
          ref: uploadBody.ref,
          label: typeof uploadBody?.title === "string" ? uploadBody.title : file.name,
          snippet: snippet || "Uploaded document available for planning context.",
          source: "uploaded",
        });
      } catch {
        continue;
      }
    }

    const selectedExistingDocs: ContextDocument[] = [];
    for (const ref of selectedExistingRefs) {
      const sourceItem = existingDocs.find((item) => item.ref === ref);
      const snippet = await loadDocumentSnippet(ref);
      selectedExistingDocs.push({
        ref,
        label: sourceItem?.title || sourceItem?.filename || ref,
        snippet: snippet || sourceItem?.preview || "Existing document selected for planning context.",
        source: "existing",
      });
    }

    const deduped = new Map<string, ContextDocument>();
    for (const item of uploadedDocs) deduped.set(item.ref, item);
    for (const item of selectedExistingDocs) deduped.set(item.ref, item);
    return Array.from(deduped.values());
  };

  const loadRoleSuggestions = async (force = false) => {
    if (roleLoading) return;
    if (!force && chatgptRole.trim() && claudeRole.trim()) return;
    if (!title.trim()) return;

    setRoleLoading(true);
    setErrorText(null);

    try {
      const suggested = suggestRolesFromPrompt({
        title: title.trim(),
        brief: brief.trim(),
      });
      setChatgptRole(suggested.chatgptRole);
      setClaudeRole(suggested.claudeRole);
      setStarterRecommendation(suggested.starter);
    } catch {
      setChatgptRole((current) => current.trim() || DEFAULT_CHATGPT_ROLE);
      setClaudeRole((current) => current.trim() || DEFAULT_CLAUDE_ROLE);
      setStarterRecommendation("chatgpt");
      setErrorText("Could not auto-suggest roles. Default roles were applied and can be edited.");
    } finally {
      setRoleLoading(false);
    }
  };

  const createTask = async () => {
    if (busy) return;
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: grillMeEnabled ? "planning" : "direct",
          title: title.trim(),
          goal: title.trim(),
          brief: brief.trim() || null,
          initialContext: brief.trim() || null,
          firstActor: starterRecommendation,
          context: {
            artifacts: {
              setup: {
                provider_roles: {
                  chatgpt: chatgptRole.trim() || null,
                  claude: claudeRole.trim() || null,
                },
              },
              context_documents: contextDocs,
            },
            migration: {
              unified_collab: true,
            },
          },
        }),
      });
      const body = await res.json();
      if (grillMeEnabled) {
        const sessionId = typeof body?.session_id === "string" ? body.session_id : null;
        if (!res.ok || !sessionId) {
          throw new Error(typeof body?.error === "string" ? body.error : "Failed to start grill-me planning");
        }
        router.push(`/dashboard/tasks/plan/${sessionId}`);
        return;
      }
      const createdTaskId = typeof body?.id === "string"
        ? body.id
        : typeof body?.task?.id === "string"
          ? body.task.id
          : null;
      if (!res.ok || !createdTaskId) {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to create collab task");
      }
      router.push(`/dashboard/tasks/kickoff/${createdTaskId}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to create collab task.");
      setBusy(false);
    }
  };

  const onContinue = async () => {
    if (step === 0) {
      setStepWaiting(true);
      setErrorText(null);
      try {
        const preparedDocs = await prepareContextDocs();
        setContextDocs(preparedDocs);
        await loadRoleSuggestions(false);
      } finally {
        setStepWaiting(false);
      }
    }
    setStep((current) => Math.min(2, current + 1));
  };

  const toggleExistingDoc = (ref: string) => {
    setSelectedExistingRefs((current) => {
      if (current.includes(ref)) return current.filter((item) => item !== ref);
      return [...current, ref];
    });
  };

  const visibleExistingDocs = useMemo(() => {
    const query = docSearch.trim().toLowerCase();
    const pool = existingDocs.filter((item) => {
      if (!query) return true;
      const haystack = `${item.title ?? ""} ${item.filename ?? ""} ${item.preview ?? ""} ${item.ref}`.toLowerCase();
      return haystack.includes(query);
    });
    return pool.slice(0, 8);
  }, [docSearch, existingDocs]);

  useEffect(() => {
    void loadExistingDocs();
  }, [loadExistingDocs]);

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const res = await fetch("/api/tasks/preferences", { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) return;
        const recommended = Boolean(body?.grillMeRecommended);
        if (!recommended) return;
        const reason =
          typeof body?.grillMeRecommendationReason === "string"
            ? body.grillMeRecommendationReason
            : "Recent task planning needed multiple corrections. Consider enabling grill-me.";
        setGrillMeRecommendation(reason);
      } catch {
        // Ignore recommendation fetch failures.
      }
    };
    void loadPreferences();
  }, []);

  return (
    <div className={styles.page}>
      {/* Step indicator */}
      <nav className={styles.steps} aria-label="Setup progress">
        {STEPS.map((s, idx) => (
          <div key={s.id} className={styles.stepItem}>
            {idx > 0 && <div className={`${styles.stepLine} ${idx <= step ? styles.stepLineDone : ""}`} />}
            <div className={`${styles.stepNode} ${s.id === step ? styles.stepNodeActive : s.id < step ? styles.stepNodeDone : styles.stepNodePending}`}>
              <span className={styles.stepNumber}>{s.id < step ? <Check size={12} strokeWidth={3} /> : s.id + 1}</span>
              <span className={styles.stepLabel}>{s.label}</span>
            </div>
          </div>
        ))}
      </nav>

      <header className={styles.header}>
        <h1 className={styles.title}>{STEPS[step].label}</h1>
        <p className={styles.subtitle}>{STEPS[step].description}</p>
      </header>

      {/* Error */}
      {errorText && (
        <div className={styles.errorBanner}>
          <span>{errorText}</span>
        </div>
      )}
      {grillMeRecommendation && step === 0 && (
        <div className={styles.recommendationBanner}>
          <span>{grillMeRecommendation}</span>
        </div>
      )}

      {/* Step 0: Scope */}
      {step === 0 && (
        <section className={styles.card}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>
              Task title
              <span className={styles.fieldRequired}>*</span>
            </label>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Draft the Series A deck"
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Brief</label>
            <div className={styles.briefComposer}>
              <textarea
                className={styles.textarea}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Include product narrative, GTM story, and metrics assumptions."
              />
              <div className={styles.briefActions}>
                <input
                  ref={fileInputRef}
                  type="file"
                  className={styles.hiddenInput}
                  accept="application/pdf,.docx,.docm,text/plain"
                  multiple
                  onChange={onPickFiles}
                />
                <button
                  type="button"
                  className={styles.fileBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={stepWaiting}
                >
                  <Upload size={14} />
                  Attach files
                </button>
                <span className={styles.fileHint}>PDF, DOCX, TXT</span>
              </div>
            </div>
            {pendingFiles.length > 0 && (
              <div className={styles.fileList}>
                {pendingFiles.map((file, index) => (
                  <span key={`${file.name}:${file.size}:${file.lastModified}`} className={styles.fileChip}>
                    <FileText size={12} />
                    <span className={styles.fileChipName}>{file.name}</span>
                    <button type="button" className={styles.fileChipRemove} onClick={() => removePendingFile(index)} aria-label="Remove file">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={styles.toggleRow}>
            <div className={styles.toggleCopy}>
              <span className={styles.toggleTitle}>Use grill-me planning</span>
              <span className={styles.toggleText}>Ask clarifying questions and approve a plan before the task starts.</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={grillMeEnabled}
              className={`${styles.switch} ${grillMeEnabled ? styles.switchOn : ""}`}
              onClick={() => setGrillMeEnabled((value) => !value)}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Existing documents</label>
            <input
              className={styles.lookupInput}
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
              placeholder="Search by title, filename, or content…"
            />
            <div className={styles.lookupList}>
              {docsLoading ? (
                <div className={styles.lookupEmpty}>
                  <Loader2 size={16} className={styles.spin} />
                  Loading documents…
                </div>
              ) : visibleExistingDocs.length === 0 ? (
                <p className={styles.lookupEmpty}>No matching documents found.</p>
              ) : (
                visibleExistingDocs.map((doc) => {
                  const label = doc.title || doc.filename || doc.ref;
                  const selected = selectedExistingRefs.includes(doc.ref);
                  return (
                    <button
                      key={doc.ref}
                      type="button"
                      className={`${styles.lookupItem} ${selected ? styles.lookupItemActive : ""}`}
                      onClick={() => toggleExistingDoc(doc.ref)}
                    >
                      <div className={styles.lookupItemLeft}>
                        <span className={`${styles.lookupCheck} ${selected ? styles.lookupCheckActive : ""}`}>
                          {selected && <Check size={10} strokeWidth={3} />}
                        </span>
                        <span className={styles.lookupItemLabel}>{label}</span>
                      </div>
                      <span className={styles.lookupItemRef}>{doc.ref.slice(0, 8)}…</span>
                    </button>
                  );
                })
              )}
            </div>
            {selectedExistingRefs.length > 0 && (
              <p className={styles.lookupSelected}>{selectedExistingRefs.length} selected</p>
            )}
          </div>

          {stepWaiting && (
            <div className={styles.waitRow}>
              <Loader2 size={14} className={styles.spin} />
              Preparing role suggestions and file context…
            </div>
          )}
        </section>
      )}

      {/* Step 1: Roles */}
      {step === 1 && (
        <section className={styles.card}>
          <div className={styles.cardHeadRow}>
            <h2 className={styles.cardTitle}>Provider roles</h2>
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => void loadRoleSuggestions(true)}
              disabled={roleLoading}
            >
              <Sparkles size={14} />
              {roleLoading ? "Generating…" : "Regenerate"}
            </button>
          </div>

          <div className={styles.roleGrid}>
            <div className={`${styles.roleCard} ${styles.roleCardChatgpt}`}>
              <div className={styles.roleCardHeader}>
                <img src="/chatgpt.svg" alt="" className={styles.roleCardIcon} />
                <div>
                  <p className={styles.roleCardTitle}>ChatGPT</p>
                  <p className={styles.roleCardSubtitle}>Creative exploration</p>
                </div>
              </div>
              <textarea
                className={styles.textareaSecondary}
                value={chatgptRole}
                onChange={(e) => setChatgptRole(e.target.value)}
                placeholder={DEFAULT_CHATGPT_ROLE}
              />
            </div>
            <div className={`${styles.roleCard} ${styles.roleCardClaude}`}>
              <div className={styles.roleCardHeader}>
                <img src="/claude.svg" alt="" className={styles.roleCardIcon} />
                <div>
                  <p className={styles.roleCardTitle}>Claude</p>
                  <p className={styles.roleCardSubtitle}>Technical refinement</p>
                </div>
              </div>
              <textarea
                className={styles.textareaSecondary}
                value={claudeRole}
                onChange={(e) => setClaudeRole(e.target.value)}
                placeholder={DEFAULT_CLAUDE_ROLE}
              />
            </div>
          </div>

          <div className={styles.starterBadge}>
            <span className={styles.starterLabel}>Recommended first actor</span>
            <span className={styles.starterValue}>
              {starterRecommendation === "chatgpt" ? (
                <>
                  <img src="/chatgpt.svg" alt="" className={styles.starterIcon} />
                  ChatGPT
                </>
              ) : (
                <>
                  <img src="/claude.svg" alt="" className={styles.starterIcon} />
                  Claude
                </>
              )}
            </span>
          </div>
        </section>
      )}

      {/* Step 2: Review */}
      {step === 2 && (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Review and create</h2>
          <p className={styles.helperText}>Confirm the details below, then create the collab task.</p>

          <div className={styles.summaryBox}>
            <div className={styles.summaryRow}>
              <span className={styles.summaryKey}>Title</span>
              <span className={styles.summaryValue}>{title.trim()}</span>
            </div>
            {brief.trim() && (
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Brief</span>
                <span className={styles.summaryValue}>{brief.trim()}</span>
              </div>
            )}
            <div className={styles.summaryRow}>
              <span className={styles.summaryKey}>ChatGPT role</span>
              <span className={styles.summaryValue}>{chatgptRole.trim()}</span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryKey}>Claude role</span>
              <span className={styles.summaryValue}>{claudeRole.trim()}</span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryKey}>First actor</span>
              <span className={styles.summaryValue}>
                {starterRecommendation === "chatgpt" ? "ChatGPT" : "Claude"}
              </span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryKey}>Planning</span>
              <span className={styles.summaryValue}>{grillMeEnabled ? "Grill-me before execution" : "Skip grill-me"}</span>
            </div>
            {contextDocs.length > 0 && (
              <div className={styles.summaryRow}>
                <span className={styles.summaryKey}>Documents</span>
                <span className={styles.summaryValue}>{contextDocs.length} linked</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => (step === 0 ? router.push("/dashboard/tasks") : setStep(step - 1))}
          disabled={busy || roleLoading || stepWaiting}
        >
          <ArrowLeft size={14} />
          {step === 0 ? "Cancel" : "Back"}
        </button>

        {step < 2 ? (
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={!canContinue || busy || roleLoading || stepWaiting}
            onClick={() => void onContinue()}
          >
            {stepWaiting ? (
              <>
                <Loader2 size={14} className={styles.spin} />
                Preparing…
              </>
            ) : (
              <>
                Continue
                <ArrowRight size={14} />
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={busy}
            onClick={() => void createTask()}
          >
            {busy ? (
              <>
                <Loader2 size={14} className={styles.spin} />
                Creating…
              </>
            ) : (
              <>
                {grillMeEnabled ? "Start Grill-Me" : "Create Task"}
                <ArrowRight size={14} />
              </>
            )}
          </button>
        )}
      </footer>
    </div>
  );
}

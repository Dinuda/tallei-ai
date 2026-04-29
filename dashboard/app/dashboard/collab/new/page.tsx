"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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

const STEPS = ["Scope", "Roles", "Start"];

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
            .filter((item): item is ExistingDocListItem => Boolean(item && typeof item === "object" && typeof item.ref === "string"))
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
      const res = await fetch("/api/collab/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          brief: brief.trim() || null,
          firstActor: starterRecommendation,
          maxIterations: 4,
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
      if (!res.ok || typeof body?.id !== "string") {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to create collab task");
      }
      router.push(`/dashboard/collab/kickoff/${body.id}`);
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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>New Collab Task</h1>
        <p className={styles.subtitle}>Plan first, then run ChatGPT and Claude with a shared execution track.</p>
        <div className={styles.dots}>
          {STEPS.map((label, idx) => (
            <span key={label} className={`${styles.dot} ${idx <= step ? styles.dotActive : ""}`} />
          ))}
        </div>
      </header>

      {step === 0 && (
        <section className={styles.card}>
          <h2>Title and brief</h2>
          <input
            className={styles.input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Draft the Series A deck"
          />

          <div className={styles.briefComposer}>
            <textarea
              className={styles.textarea}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Include product narrative, GTM story, and metrics assumptions."
            />
            <input
              ref={fileInputRef}
              type="file"
              className={styles.hiddenInput}
              accept="application/pdf,.docx,.docm,text/plain"
              multiple
              onChange={onPickFiles}
            />
            <div className={styles.briefActions}>
              <button type="button" className={styles.fileIconBtn} onClick={() => fileInputRef.current?.click()} disabled={stepWaiting} aria-label="Attach files">
                +
              </button>
              <span className={styles.fileHint}>Attach files (PDF/DOCX). You can add many.</span>
            </div>
            {pendingFiles.length > 0 ? (
              <div className={styles.fileChips}>
                {pendingFiles.map((file, index) => (
                  <span key={`${file.name}:${file.size}:${file.lastModified}`} className={styles.fileChip}>
                    {file.name}
                    <button type="button" onClick={() => removePendingFile(index)} aria-label="Remove file">×</button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className={styles.lookupBlock}>
              <p className={styles.lookupTitle}>Lookup existing documents</p>
              <input
                className={styles.lookupInput}
                value={docSearch}
                onChange={(event) => setDocSearch(event.target.value)}
                placeholder="Search docs by title, filename, preview, or @doc ref"
              />
              <div className={styles.lookupList}>
                {docsLoading ? (
                  <p className={styles.lookupEmpty}>Loading documents...</p>
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
                        <span>{label}</span>
                        <small>{doc.ref}</small>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {stepWaiting ? (
            <div className={styles.waitRow}>
              <span className={styles.waitDot} />
              Preparing role suggestions and file context...
            </div>
          ) : null}
        </section>
      )}

      {step === 1 && (
        <section className={styles.card}>
          <div className={styles.cardHeadRow}>
            <h2>Provider roles</h2>
            <button type="button" className={styles.secondaryBtn} onClick={() => void loadRoleSuggestions(true)} disabled={roleLoading}>
              {roleLoading ? "Refreshing..." : "Refresh suggestions"}
            </button>
          </div>

          <div className={styles.roleGrid}>
            <div className={styles.roleCard}>
              <p className={styles.roleTitle}>ChatGPT (Creative)</p>
              <textarea
                className={styles.textareaSecondary}
                value={chatgptRole}
                onChange={(event) => setChatgptRole(event.target.value)}
                placeholder={DEFAULT_CHATGPT_ROLE}
              />
            </div>
            <div className={styles.roleCard}>
              <p className={styles.roleTitle}>Claude (Technical)</p>
              <textarea
                className={styles.textareaSecondary}
                value={claudeRole}
                onChange={(event) => setClaudeRole(event.target.value)}
                placeholder={DEFAULT_CLAUDE_ROLE}
              />
            </div>
          </div>

          <p className={styles.helperText}>
            Planner recommends starting with <strong>{starterRecommendation === "chatgpt" ? "ChatGPT" : "Claude"}</strong> based on your prompt.
          </p>
        </section>
      )}

      {step === 2 && (
        <section className={styles.card}>
          <h2>Create unified collab task</h2>
          <p className={styles.helperText}>This creates one shared collab task and opens dual kickoff prompts for ChatGPT and Claude.</p>
          <div className={styles.summaryBox}>
            <p><strong>Title:</strong> {title.trim()}</p>
            {brief.trim() ? <p><strong>Brief:</strong> {brief.trim()}</p> : null}
            <p><strong>ChatGPT role:</strong> {chatgptRole.trim()}</p>
            <p><strong>Claude role:</strong> {claudeRole.trim()}</p>
            {contextDocs.length > 0 ? <p><strong>Files linked:</strong> {contextDocs.length}</p> : null}
          </div>
        </section>
      )}

      {errorText ? <p className={styles.errorText}>{errorText}</p> : null}

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => (step === 0 ? router.push("/dashboard/collab") : setStep(step - 1))}
          disabled={busy || roleLoading || stepWaiting}
        >
          Back
        </button>

        {step < 2 ? (
          <button type="button" className={styles.primaryBtn} disabled={!canContinue || busy || roleLoading || stepWaiting} onClick={() => void onContinue()}>
            {stepWaiting ? "Preparing..." : "Continue"}
          </button>
        ) : (
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void createTask()}>
            {busy ? "Creating..." : "Create Task"}
          </button>
        )}
      </footer>
    </div>
  );
}

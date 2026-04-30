"use client";

import { useEffect, useState } from "react";
import { FileText, X, ChevronRight } from "lucide-react";
import styles from "./DocumentCard.module.css";

type DocumentStatus = "pending" | "ready" | "failed";

interface TaskDocument {
  ref: string;
  title: string;
  filename: string | null;
  status: DocumentStatus;
  preview: string;
}

interface LiveDocumentState {
  status: DocumentStatus;
  preview: string;
}

const STATUS_STYLES: Record<DocumentStatus, { bg: string; border: string; text: string }> = {
  pending: { bg: "var(--status-info-bg)", border: "var(--status-info-border)", text: "var(--status-info-text)" },
  ready: { bg: "var(--status-success-bg)", border: "var(--status-success-border)", text: "var(--status-success-text)" },
  failed: { bg: "var(--status-error-bg)", border: "var(--status-error-border)", text: "var(--status-error-text)" },
};

function getFileIcon(filename: string | null) {
  if (!filename) return <FileText size={18} />;
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return <FileText size={18} />;
  if (ext === "docx" || ext === "doc") return <FileText size={18} />;
  return <FileText size={18} />;
}

interface DocumentCardProps {
  documents: TaskDocument[];
  lotTitle: string | null;
  countSaved: number;
  countFailed: number;
}

export default function DocumentCard({ documents, lotTitle, countSaved, countFailed }: DocumentCardProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<TaskDocument | null>(null);
  const [drawerContent, setDrawerContent] = useState<string>("");
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [liveByRef, setLiveByRef] = useState<Record<string, LiveDocumentState>>({});

  const liveFor = (doc: TaskDocument): LiveDocumentState => {
    const live = liveByRef[doc.ref];
    if (!live) return { status: doc.status, preview: doc.preview };
    return live;
  };

  useEffect(() => {
    let cancelled = false;

    const refreshLiveState = async () => {
      for (const doc of documents) {
        try {
          const res = await fetch(`/api/documents/${encodeURIComponent(doc.ref)}`, { cache: "no-store" });
          const payload = await res.json();
          if (!res.ok) continue;
          if (!payload || typeof payload !== "object" || payload.kind !== "document") continue;

          const statusRaw = typeof payload.status === "string" ? payload.status : "";
          const liveStatus: DocumentStatus =
            statusRaw === "ready"
              ? "ready"
              : statusRaw === "failed_indexing"
                ? "failed"
                : "pending";
          const content = typeof payload.content === "string" ? payload.content : "";
          const resolvedPreview = content || doc.preview || "";

          if (cancelled) return;
          setLiveByRef((prev) => ({
            ...prev,
            [doc.ref]: { status: liveStatus, preview: resolvedPreview },
          }));
        } catch {
          // Keep snapshot values when live fetch fails.
        }
      }
    };

    void refreshLiveState();

    return () => {
      cancelled = true;
    };
  }, [documents]);

  const openDrawer = async (doc: TaskDocument) => {
    setSelectedDoc(doc);
    setDrawerOpen(true);
    setDrawerError(null);
    setDrawerLoading(true);
    const current = liveFor(doc);
    setDrawerContent(current.preview || "");

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(doc.ref)}`, { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) {
        const message = typeof payload?.error === "string" ? payload.error : "Failed to load document content.";
        throw new Error(message);
      }

      const content =
        payload &&
        typeof payload === "object" &&
        payload.kind === "document" &&
        typeof payload.content === "string"
          ? payload.content
          : "";
      const statusRaw =
        payload &&
        typeof payload === "object" &&
        payload.kind === "document" &&
        typeof payload.status === "string"
          ? payload.status
          : "";
      const liveStatus: DocumentStatus =
        statusRaw === "ready"
          ? "ready"
          : statusRaw === "failed_indexing"
            ? "failed"
            : "pending";
      const resolvedPreview = content || current.preview || doc.preview || "No preview available.";
      setLiveByRef((prev) => ({
        ...prev,
        [doc.ref]: {
          status: liveStatus,
          preview: resolvedPreview,
        },
      }));
      setDrawerContent(resolvedPreview);
    } catch (error) {
      setDrawerError(error instanceof Error ? error.message : "Failed to load document content.");
      setDrawerContent(current.preview || doc.preview || "No preview available.");
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedDoc(null);
    setDrawerLoading(false);
    setDrawerError(null);
    setDrawerContent("");
  };

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.header}>
          <h3 className={styles.title}>Attached Documents</h3>
          <span className={styles.meta}>
            {countSaved} saved{countFailed > 0 ? ` · ${countFailed} failed` : ""}
          </span>
        </div>

        {lotTitle && <p className={styles.lotTitle}>Lot: {lotTitle}</p>}

        <div className={styles.docList}>
          {documents.map((doc) => {
            const live = liveFor(doc);
            const statusStyle = STATUS_STYLES[live.status];
            return (
              <button
                key={doc.ref}
                type="button"
                className={styles.docRow}
                onClick={() => void openDrawer(doc)}
              >
                <div className={styles.docIcon}>{getFileIcon(doc.filename)}</div>
                <div className={styles.docInfo}>
                  <p className={styles.docTitle}>{doc.title}</p>
                  <p className={styles.docFilename}>{doc.filename ?? doc.ref}</p>
                </div>
                <div className={styles.docRight}>
                  <span
                    className={styles.docStatus}
                    style={{
                      background: statusStyle.bg,
                      borderColor: statusStyle.border,
                      color: statusStyle.text,
                    }}
                  >
                    {live.status}
                  </span>
                  <ChevronRight size={14} className={styles.docArrow} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {drawerOpen && selectedDoc && (
        <div className={styles.drawerBackdrop} onClick={closeDrawer}>
          <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.drawerHeader}>
              <div>
                <h3 className={styles.drawerTitle}>{selectedDoc.title}</h3>
                <p className={styles.drawerMeta}>{selectedDoc.filename ?? selectedDoc.ref}</p>
              </div>
              <button type="button" className={styles.drawerClose} onClick={closeDrawer}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.drawerBody}>
              {drawerLoading && <pre className={styles.drawerPreview}>Loading document content…</pre>}
              {!drawerLoading && drawerError && <pre className={styles.drawerPreview}>{drawerError}</pre>}
              {!drawerLoading && !drawerError && <pre className={styles.drawerPreview}>{drawerContent || "No preview available."}</pre>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

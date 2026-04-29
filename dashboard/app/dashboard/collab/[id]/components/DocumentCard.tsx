"use client";

import { useState } from "react";
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

  const openDrawer = (doc: TaskDocument) => {
    setSelectedDoc(doc);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedDoc(null);
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
            const statusStyle = STATUS_STYLES[doc.status];
            return (
              <button
                key={doc.ref}
                type="button"
                className={styles.docRow}
                onClick={() => openDrawer(doc)}
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
                    {doc.status}
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
              <pre className={styles.drawerPreview}>{selectedDoc.preview}</pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

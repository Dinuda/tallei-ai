"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Clock, Copy, FileText, FolderOpen, RefreshCw, Trash2, ExternalLink } from "lucide-react";
import { useSession } from "next-auth/react";
import { EmptyCollectionState } from "../components/empty-collection-state";
import styles from "./page.module.css";

type DocStatus = "pending" | "ready" | "failed";

type BlobMeta = {
  provider: "uploadthing";
  key: string;
  url: string;
  source_file_id: string;
};

type DocListItem = {
  ref: string;
  filename: string | null;
  title: string | null;
  preview: string;
  byteSize: number;
  status: DocStatus;
  createdAt: string;
  lotRef: string | null;
  lotTitle: string | null;
  blob: BlobMeta | null;
};

type LotListItem = {
  ref: string;
  title: string | null;
  createdAt: string;
  documentCount: number;
};

type ModalDocument = {
  ref: string;
  filename: string | null;
  title: string | null;
  content: string;
  status: "ready" | "pending_embedding" | "failed_indexing";
  blob: BlobMeta | null;
};

type ModalPayload =
  | {
      kind: "document";
      ref: string;
      filename: string | null;
      title: string | null;
      content: string;
      status: "ready" | "pending_embedding" | "failed_indexing";
      blob: BlobMeta | null;
    }
  | {
      kind: "lot";
      ref: string;
      title: string | null;
      docs: ModalDocument[];
    };

const PAGE_SIZE = 10;
const DOCUMENTS_EMPTY_IMAGE = "/document-i.png";

const STATUS_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  ready: { bg: "#16a34a", color: "#fff", label: "Ready" },
  pending: { bg: "#ea580c", color: "#fff", label: "Pending" },
  pending_embedding: { bg: "#ea580c", color: "#fff", label: "Pending" },
  failed: { bg: "#dc2626", color: "#fff", label: "Failed" },
  failed_indexing: { bg: "#dc2626", color: "#fff", label: "Failed" },
};

function statusStyle(status: string) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isPlanRequired(data: unknown, statusCode: number): boolean {
  if (statusCode === 402) return true;
  if (!data || typeof data !== "object") return false;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && code.toLowerCase() === "plan_required";
}

function DocCard({ doc, isExpanded, onToggle, onView, onCopy }: {
  doc: DocListItem;
  isExpanded: boolean;
  onToggle: () => void;
  onView: () => void;
  onCopy: () => void;
}) {
  const name = (doc.filename ?? doc.title ?? "Untitled").slice(0, 64);
  const previewText = doc.preview ? (doc.preview.length > 120 ? doc.preview.slice(0, 120) + "..." : doc.preview) : "";
  const status = statusStyle(doc.status);

  return (
    <div className={`${styles.memoryCard} ${isExpanded ? styles.memoryCardExpanded : ""}`}>
      <button className={styles.memoryCardHeader} onClick={onToggle} aria-expanded={isExpanded}>
        <div className={styles.memoryCardLeft}>
          <span className={styles.platformBadge} style={{ background: status.bg, color: status.color }}>
            <FileText size={12} style={{ flexShrink: 0 }} />
            {status.label}
          </span>
          <span className={styles.memoryPreviewText}>{isExpanded ? name : (previewText || name)}</span>
        </div>
        <div className={styles.memoryCardRight}>
          <span className={styles.memoryDate}>
            <Clock size={13} />
            {relativeDate(doc.createdAt)}
          </span>
          <span className={styles.categoryBadge}>{formatSize(doc.byteSize)}</span>
          <ChevronDown size={16} className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} />
        </div>
      </button>

      {isExpanded && (
        <div className={styles.memoryCardBody}>
          <div className={styles.memoryFullText}>
            {previewText || "No preview available."}
          </div>
          <div className={styles.memoryMeta}>
            <div className={styles.memoryMetaRow}>
              <span className={styles.metaLabel}>Ref</span>
              <span className={styles.metaValue} style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{doc.ref}</span>
            </div>
            {doc.lotRef && (
              <div className={styles.memoryMetaRow}>
                <span className={styles.metaLabel}>Lot</span>
                <span className={styles.metaValue} style={{ fontFamily: "monospace" }}>{doc.lotRef}</span>
              </div>
            )}
            <div className={styles.memoryMetaRow}>
              <span className={styles.metaLabel}>Created</span>
              <span className={styles.metaValue}>{new Date(doc.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div className={styles.memoryCardActions}>
            <button className={styles.actionBtnSmall} onClick={onCopy} title="Copy ref">
              <Copy size={14} />
              Copy ref
            </button>
            {doc.blob?.url && (
              <a className={styles.actionBtnSmall} href={doc.blob.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                Open file
              </a>
            )}
            <button className={styles.actionBtnPrimary} onClick={onView}>
              View full content
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LotCard({ lot, isExpanded, onToggle, onView, onCopy }: {
  lot: LotListItem;
  isExpanded: boolean;
  onToggle: () => void;
  onView: () => void;
  onCopy: () => void;
}) {
  return (
    <div className={`${styles.memoryCard} ${isExpanded ? styles.memoryCardExpanded : ""}`}>
      <button className={styles.memoryCardHeader} onClick={onToggle} aria-expanded={isExpanded}>
        <div className={styles.memoryCardLeft}>
          <span className={styles.platformBadge} style={{ background: "#6366f1", color: "#fff" }}>
            <FolderOpen size={12} style={{ flexShrink: 0 }} />
            Lot
          </span>
          <span className={styles.memoryPreviewText}>{lot.title ?? "Untitled lot"}</span>
        </div>
        <div className={styles.memoryCardRight}>
          <span className={styles.memoryDate}>
            <Clock size={13} />
            {relativeDate(lot.createdAt)}
          </span>
          <span className={styles.categoryBadge}>{lot.documentCount} doc{lot.documentCount !== 1 ? "s" : ""}</span>
          <ChevronDown size={16} className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`} />
        </div>
      </button>

      {isExpanded && (
        <div className={styles.memoryCardBody}>
          <div className={styles.memoryMeta}>
            <div className={styles.memoryMetaRow}>
              <span className={styles.metaLabel}>Ref</span>
              <span className={styles.metaValue} style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{lot.ref}</span>
            </div>
            <div className={styles.memoryMetaRow}>
              <span className={styles.metaLabel}>Created</span>
              <span className={styles.metaValue}>{new Date(lot.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div className={styles.memoryCardActions}>
            <button className={styles.actionBtnSmall} onClick={onCopy} title="Copy ref">
              <Copy size={14} />
              Copy ref
            </button>
            <button className={styles.actionBtnPrimary} onClick={onView}>
              View documents
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DocumentsPage() {
  const { status: sessionStatus } = useSession();
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [lots, setLots] = useState<LotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proRequired, setProRequired] = useState(false);
  const [docPage, setDocPage] = useState(1);
  const [lotPage, setLotPage] = useState(1);
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());
  const [expandedLotIds, setExpandedLotIds] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<ModalPayload | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      if (sessionStatus === "loading") return;

      const res = await fetch("/api/documents");
      const data = await res.json();

      if (isPlanRequired(data, res.status)) {
        setProRequired(true);
        setError(typeof data?.error === "string" ? data.error : "Documents are available on Pro.");
        setDocs([]);
        setLots([]);
        return;
      }

      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to load documents.");
      }

      setProRequired(false);
      setDocs(Array.isArray(data?.docs) ? data.docs : []);
      setLots(Array.isArray(data?.lots) ? data.lots : []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load documents.");
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== "loading") {
      void load("initial");
    }
  }, [load, sessionStatus]);

  const openRef = useCallback(async (ref: string) => {
    setLoadingSelected(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(ref)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to load item.");
      }
      setSelected(data as ModalPayload);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to load item.");
    } finally {
      setLoadingSelected(false);
    }
  }, []);

  const copyRef = useCallback(async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      setError("Unable to copy reference.");
    }
  }, []);

  const removeSelected = useCallback(async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(selected.ref)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Delete failed.");
      }
      setSelected(null);
      await load("refresh");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }, [load, selected]);

  const toggleDocExpand = useCallback((id: string) => {
    setExpandedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleLotExpand = useCallback((id: string) => {
    setExpandedLotIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const docPageCount = useMemo(() => Math.max(1, Math.ceil(docs.length / PAGE_SIZE)), [docs.length]);
  const lotPageCount = useMemo(() => Math.max(1, Math.ceil(lots.length / PAGE_SIZE)), [lots.length]);

  const visibleDocs = useMemo(() => {
    const start = (docPage - 1) * PAGE_SIZE;
    return docs.slice(start, start + PAGE_SIZE);
  }, [docPage, docs]);

  const visibleLots = useMemo(() => {
    const start = (lotPage - 1) * PAGE_SIZE;
    return lots.slice(start, start + PAGE_SIZE);
  }, [lotPage, lots]);

  useEffect(() => { setDocPage((c) => Math.min(c, docPageCount)); }, [docPageCount]);
  useEffect(() => { setLotPage((c) => Math.min(c, lotPageCount)); }, [lotPageCount]);

  const docRangeStart = docs.length === 0 ? 0 : (docPage - 1) * PAGE_SIZE + 1;
  const docRangeEnd = Math.min(docPage * PAGE_SIZE, docs.length);
  const lotRangeStart = lots.length === 0 ? 0 : (lotPage - 1) * PAGE_SIZE + 1;
  const lotRangeEnd = Math.min(lotPage * PAGE_SIZE, lots.length);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Documents</h1>
          <p className={styles.pageSubtitle}>Full document stash references and lots.</p>
        </div>
        <div className={styles.headerRight}>
          <button
            className={styles.actionBtn}
            onClick={() => void load("refresh")}
            disabled={loading || refreshing}
          >
            <RefreshCw size={16} className={refreshing ? styles.spin : ""} />
            Refresh
          </button>
        </div>
      </header>

      {error && !proRequired && (
        <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>
      )}

      {proRequired ? (
        <EmptyCollectionState
          title="No documents found"
          description="Upgrade to Pro or Power to monitor documents here."
          actionLabel="Upgrade"
          actionHref="/dashboard/billing"
          imageSrc={DOCUMENTS_EMPTY_IMAGE || undefined}
          illustration="none"
        />
      ) : loading && docs.length === 0 ? (
        <div className={styles.cardList}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={styles.skeletonCard}>
              <div className={styles.skeletonCardHeader}>
                <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
                <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              </div>
              <div className={styles.skeletonCardMeta}>
                <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
                <div className={`${styles.skeleton} ${styles.skeletonTag}`} />
              </div>
            </div>
          ))}
        </div>
      ) : docs.length === 0 && lots.length === 0 ? (
        <EmptyCollectionState
          title="No documents found"
          description="Connect Tallei in production to monitor documents here."
          actionLabel="Connect Tallei"
          actionHref="/dashboard/setup"
          imageSrc={DOCUMENTS_EMPTY_IMAGE || undefined}
          illustration="none"
        />
      ) : (
        <>
          {docs.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <FileText size={16} />
                  Documents
                </h2>
                <span className={styles.sectionCount}>{docRangeStart}-{docRangeEnd} of {docs.length}</span>
              </div>
              <div className={styles.cardList}>
                {visibleDocs.map((doc) => (
                  <DocCard
                    key={doc.ref}
                    doc={doc}
                    isExpanded={expandedDocIds.has(doc.ref)}
                    onToggle={() => toggleDocExpand(doc.ref)}
                    onView={() => void openRef(doc.ref)}
                    onCopy={() => void copyRef(doc.ref)}
                  />
                ))}
              </div>
              {docPageCount > 1 && (
                <div className={styles.pagination}>
                  <button
                    className={styles.pageBtn}
                    onClick={() => setDocPage((c) => Math.max(1, c - 1))}
                    disabled={docPage === 1}
                  >
                    Previous
                  </button>
                  <span className={styles.pageInfo}>Page {docPage} / {docPageCount}</span>
                  <button
                    className={styles.pageBtn}
                    onClick={() => setDocPage((c) => Math.min(docPageCount, c + 1))}
                    disabled={docPage === docPageCount}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          )}

          {lots.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <FolderOpen size={16} />
                  Lots
                </h2>
                <span className={styles.sectionCount}>{lotRangeStart}-{lotRangeEnd} of {lots.length}</span>
              </div>
              <div className={styles.cardList}>
                {visibleLots.map((lot) => (
                  <LotCard
                    key={lot.ref}
                    lot={lot}
                    isExpanded={expandedLotIds.has(lot.ref)}
                    onToggle={() => toggleLotExpand(lot.ref)}
                    onView={() => void openRef(lot.ref)}
                    onCopy={() => void copyRef(lot.ref)}
                  />
                ))}
              </div>
              {lotPageCount > 1 && (
                <div className={styles.pagination}>
                  <button
                    className={styles.pageBtn}
                    onClick={() => setLotPage((c) => Math.max(1, c - 1))}
                    disabled={lotPage === 1}
                  >
                    Previous
                  </button>
                  <span className={styles.pageInfo}>Page {lotPage} / {lotPageCount}</span>
                  <button
                    className={styles.pageBtn}
                    onClick={() => setLotPage((c) => Math.min(lotPageCount, c + 1))}
                    disabled={lotPage === lotPageCount}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {(loadingSelected || selected) && (
        <div className={styles.modalBackdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalHeaderLeft}>
                {selected?.kind === "lot" ? <FolderOpen size={16} /> : <FileText size={16} />}
                <strong className={styles.modalTitle}>{selected?.ref ?? "Loading..."}</strong>
              </div>
              <div className={styles.modalHeaderRight}>
                {selected && (
                  <button className={styles.deleteBtn} onClick={() => void removeSelected()} disabled={deleting}>
                    <Trash2 size={15} />
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                )}
                <button className={styles.actionBtnSmall} onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            </div>

            <div className={styles.modalBody}>
              {loadingSelected || !selected ? (
                <p className={styles.modalLoading}>Loading...</p>
              ) : selected.kind === "document" ? (
                <>
                  <div className={styles.modalMetaRow}>
                    <span>{selected.filename ?? selected.title ?? "Untitled"}</span>
                    {selected.blob?.url && (
                      <a href={selected.blob.url} target="_blank" rel="noreferrer" className={styles.modalLink}>
                        Open original file
                      </a>
                    )}
                    <span
                      className={styles.platformBadge}
                      style={{ background: statusStyle(selected.status).bg, color: statusStyle(selected.status).color }}
                    >
                      {statusStyle(selected.status).label}
                    </span>
                  </div>
                  <pre className={styles.modalPre}>{selected.content}</pre>
                </>
              ) : (
                <div className={styles.modalDocStack}>
                  {selected.docs.map((doc) => (
                    <div key={doc.ref} className={styles.modalDocItem}>
                      <div className={styles.modalDocHeader}>
                        <span style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>{doc.ref}</span>
                        {doc.blob?.url && (
                          <a href={doc.blob.url} target="_blank" rel="noreferrer" className={styles.modalLink}>
                            Open file
                          </a>
                        )}
                      </div>
                      <pre className={styles.modalPreSmall}>{doc.content}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

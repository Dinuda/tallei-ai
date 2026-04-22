"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, FileText, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusChip(status: DocStatus | "pending_embedding" | "failed_indexing") {
  if (status === "ready") {
    return { label: "Ready", bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" };
  }
  if (status === "failed" || status === "failed_indexing") {
    return { label: "Failed", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" };
  }
  return { label: "Pending", bg: "#fff7ed", color: "#9a3412", border: "#fed7aa" };
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DocumentsPage() {
  const { data: session, status: sessionStatus } = useSession();
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [lots, setLots] = useState<LotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proRequired, setProRequired] = useState(false);
  const [docPage, setDocPage] = useState(1);
  const [lotPage, setLotPage] = useState(1);

  const [selected, setSelected] = useState<ModalPayload | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const plan = session?.user?.plan;

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      if (sessionStatus === "loading") return;
      if (plan === "free") {
        setProRequired(true);
        setError(null);
        setDocs([]);
        setLots([]);
        return;
      }

      const res = await fetch("/api/documents");
      const data = await res.json();

      if (res.status === 402) {
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
  }, [plan, sessionStatus]);

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

  const hasItems = useMemo(() => docs.length > 0 || lots.length > 0, [docs.length, lots.length]);
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

  useEffect(() => {
    setDocPage((current) => Math.min(current, docPageCount));
  }, [docPageCount]);

  useEffect(() => {
    setLotPage((current) => Math.min(current, lotPageCount));
  }, [lotPageCount]);

  const docRangeStart = docs.length === 0 ? 0 : (docPage - 1) * PAGE_SIZE + 1;
  const docRangeEnd = Math.min(docPage * PAGE_SIZE, docs.length);
  const lotRangeStart = lots.length === 0 ? 0 : (lotPage - 1) * PAGE_SIZE + 1;
  const lotRangeEnd = Math.min(lotPage * PAGE_SIZE, lots.length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 980, margin: "0 auto", paddingBottom: "3rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text)" }}>Documents</h1>
          <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>
            Full document stash references and lots.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load("refresh")}
          disabled={refreshing || loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.45rem",
            padding: "0.5rem 0.8rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            color: "var(--text-2)",
            cursor: refreshing || loading ? "wait" : "pointer",
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "0.75rem 0.9rem", color: "#991b1b", fontSize: "0.88rem" }}>
          {error}
        </div>
      )}

      {proRequired ? (
        <Alert style={{ boxShadow: "var(--shadow-sm)" }}>
          <AlertTitle>Documents is a Pro feature</AlertTitle>
          <AlertDescription style={{ color: "var(--text-muted)" }}>
            Upgrade to Pro or Power to stash full documents, create lots, and recall full markdown by reference.
          </AlertDescription>
          <div style={{ marginTop: "0.85rem" }}>
            <Button asChild>
              <a href="/dashboard/billing">View plans</a>
            </Button>
          </div>
        </Alert>
      ) : loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {[1, 2, 3].map((value) => (
            <div key={value} style={{ height: 64, minWidth: 760, borderRadius: 12, border: "1px solid var(--border-light)", background: "var(--surface)" }} />
          ))}
        </div>
      ) : !hasItems ? (
        <div style={{
          border: "1px solid var(--border-light)",
          borderRadius: 14,
          background: "var(--surface)",
          padding: "2rem 1rem",
          textAlign: "center",
          color: "var(--text-muted)",
        }}>
          No stashed documents yet.
        </div>
      ) : (
        <>
          <section style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}>
            <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--text)" }}>
              Documents
            </div>
            <div style={{ maxHeight: 420, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <tr style={{ background: "#fafafa", borderBottom: "1px solid var(--border-light)" }}>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Ref</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>File</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Lot</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Size</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDocs.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "0.9rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.84rem" }}>
                        No documents on this page.
                      </td>
                    </tr>
                  ) : visibleDocs.map((doc) => {
                    const chip = statusChip(doc.status);
                    return (
                      <tr key={doc.ref} style={{ borderBottom: "1px solid var(--border-light)" }}>
                        <td style={{ padding: "0.7rem 0.85rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                            <button
                              type="button"
                              onClick={() => void openRef(doc.ref)}
                              style={{
                                border: "none",
                                background: "transparent",
                                color: "var(--text)",
                                cursor: "pointer",
                                fontFamily: "monospace",
                                fontSize: "0.8rem",
                                padding: 0,
                                textAlign: "left",
                              }}
                            >
                              {doc.ref}
                            </button>
                            <button
                              type="button"
                              onClick={() => void copyRef(doc.ref)}
                              style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
                              aria-label={`Copy ${doc.ref}`}
                            >
                              <Copy size={13} />
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-2)", fontSize: "0.86rem" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                            <span>{(doc.filename ?? doc.title ?? "Untitled").slice(0, 64)}</span>
                            {doc.preview ? (
                              <span style={{ color: "var(--text-muted)", fontSize: "0.75rem", lineHeight: 1.35 }}>
                                {doc.preview}
                              </span>
                            ) : null}
                            {doc.blob?.url ? (
                              <a
                                href={doc.blob.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontSize: "0.75rem", color: "#2563eb", textDecoration: "none" }}
                              >
                                Open file
                              </a>
                            ) : null}
                          </div>
                        </td>
                        <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-muted)", fontSize: "0.82rem", fontFamily: "monospace" }}>
                          {doc.lotRef ?? "-"}
                        </td>
                        <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-muted)", fontSize: "0.83rem" }}>
                          {formatSize(doc.byteSize)}
                        </td>
                        <td style={{ padding: "0.7rem 0.85rem" }}>
                          <span style={{
                            display: "inline-flex",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            borderRadius: 999,
                            padding: "0.2rem 0.5rem",
                            background: chip.bg,
                            color: chip.color,
                            border: `1px solid ${chip.border}`,
                          }}>
                            {chip.label}
                          </span>
                        </td>
                        <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-muted)", fontSize: "0.83rem" }}>
                          {relativeDate(doc.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{
              borderTop: "1px solid var(--border-light)",
              padding: "0.65rem 0.9rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.65rem",
              flexWrap: "wrap",
            }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                Showing {docRangeStart}-{docRangeEnd} of {docs.length}
              </span>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <button
                  type="button"
                  onClick={() => setDocPage((current) => Math.max(1, current - 1))}
                  disabled={docPage === 1}
                  style={{
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-2)",
                    borderRadius: 8,
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.55rem",
                    cursor: docPage === 1 ? "not-allowed" : "pointer",
                    opacity: docPage === 1 ? 0.55 : 1,
                  }}
                >
                  Prev
                </button>
                <span style={{ color: "var(--text-muted)", fontSize: "0.78rem", minWidth: 70, textAlign: "center" }}>
                  Page {docPage} / {docPageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setDocPage((current) => Math.min(docPageCount, current + 1))}
                  disabled={docPage === docPageCount}
                  style={{
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-2)",
                    borderRadius: 8,
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.55rem",
                    cursor: docPage === docPageCount ? "not-allowed" : "pointer",
                    opacity: docPage === docPageCount ? 0.55 : 1,
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </section>

          <section style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}>
            <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--text)" }}>
              Lots
            </div>
            <div style={{ maxHeight: 420, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead>
                  <tr style={{ background: "#fafafa", borderBottom: "1px solid var(--border-light)" }}>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Lot Ref</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Title</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Docs</th>
                    <th style={{ textAlign: "left", padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLots.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "0.9rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.84rem" }}>
                        No lots on this page.
                      </td>
                    </tr>
                  ) : visibleLots.map((lot) => (
                    <tr key={lot.ref} style={{ borderBottom: "1px solid var(--border-light)" }}>
                      <td style={{ padding: "0.7rem 0.85rem" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                          <button
                            type="button"
                            onClick={() => void openRef(lot.ref)}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "var(--text)",
                              cursor: "pointer",
                              fontFamily: "monospace",
                              fontSize: "0.8rem",
                              padding: 0,
                              textAlign: "left",
                            }}
                          >
                            {lot.ref}
                          </button>
                          <button
                            type="button"
                            onClick={() => void copyRef(lot.ref)}
                            style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
                            aria-label={`Copy ${lot.ref}`}
                          >
                            <Copy size={13} />
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-2)", fontSize: "0.86rem" }}>
                        {lot.title ?? "Untitled lot"}
                      </td>
                      <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-muted)", fontSize: "0.83rem" }}>
                        {lot.documentCount}
                      </td>
                      <td style={{ padding: "0.7rem 0.85rem", color: "var(--text-muted)", fontSize: "0.83rem" }}>
                        {relativeDate(lot.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{
              borderTop: "1px solid var(--border-light)",
              padding: "0.65rem 0.9rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.65rem",
              flexWrap: "wrap",
            }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                Showing {lotRangeStart}-{lotRangeEnd} of {lots.length}
              </span>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <button
                  type="button"
                  onClick={() => setLotPage((current) => Math.max(1, current - 1))}
                  disabled={lotPage === 1}
                  style={{
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-2)",
                    borderRadius: 8,
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.55rem",
                    cursor: lotPage === 1 ? "not-allowed" : "pointer",
                    opacity: lotPage === 1 ? 0.55 : 1,
                  }}
                >
                  Prev
                </button>
                <span style={{ color: "var(--text-muted)", fontSize: "0.78rem", minWidth: 70, textAlign: "center" }}>
                  Page {lotPage} / {lotPageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setLotPage((current) => Math.min(lotPageCount, current + 1))}
                  disabled={lotPage === lotPageCount}
                  style={{
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-2)",
                    borderRadius: 8,
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.55rem",
                    cursor: lotPage === lotPageCount ? "not-allowed" : "pointer",
                    opacity: lotPage === lotPageCount ? 0.55 : 1,
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {(loadingSelected || selected) && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15, 23, 42, 0.48)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={() => {
            if (!loadingSelected) setSelected(null);
          }}
        >
          <div
            style={{
              width: "min(980px, 100%)",
              maxHeight: "90vh",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{
              padding: "0.8rem 1rem",
              borderBottom: "1px solid var(--border-light)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.8rem",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                {selected?.kind === "lot" ? <FolderOpen size={16} /> : <FileText size={16} />}
                <strong style={{ color: "var(--text)", fontSize: "0.92rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {selected?.ref ?? "Loading..."}
                </strong>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                {selected && (
                  <button
                    type="button"
                    onClick={() => void removeSelected()}
                    disabled={deleting}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      border: "1px solid #fecaca",
                      background: "#fef2f2",
                      color: "#991b1b",
                      borderRadius: 8,
                      fontSize: "0.8rem",
                      padding: "0.35rem 0.55rem",
                      cursor: deleting ? "wait" : "pointer",
                    }}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  style={{
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text-2)",
                    borderRadius: 8,
                    fontSize: "0.8rem",
                    padding: "0.35rem 0.55rem",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            <div style={{ padding: "0.85rem 1rem", overflow: "auto" }}>
              {loadingSelected || !selected ? (
                <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading...</p>
              ) : selected.kind === "document" ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>{selected.filename ?? selected.title ?? "Untitled"}</span>
                    {selected.blob?.url ? (
                      <a
                        href={selected.blob.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: "0.78rem", color: "#2563eb", textDecoration: "none" }}
                      >
                        Open original file
                      </a>
                    ) : null}
                    <span style={{
                      display: "inline-flex",
                      borderRadius: 999,
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      border: `1px solid ${statusChip(selected.status).border}`,
                      color: statusChip(selected.status).color,
                      background: statusChip(selected.status).bg,
                    }}>
                      {statusChip(selected.status).label}
                    </span>
                  </div>
                  <pre style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: "0.84rem",
                    lineHeight: 1.5,
                    color: "var(--text-2)",
                    background: "#f8fafc",
                    border: "1px solid var(--border-light)",
                    borderRadius: 10,
                    padding: "0.85rem",
                  }}>{selected.content}</pre>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                  {selected.docs.map((doc) => (
                    <div key={doc.ref} style={{ border: "1px solid var(--border-light)", borderRadius: 10, overflow: "hidden" }}>
                      <div style={{ padding: "0.55rem 0.7rem", borderBottom: "1px solid var(--border-light)", background: "#fafafa", color: "var(--text)", fontSize: "0.82rem", fontFamily: "monospace" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                          <span>{doc.ref}</span>
                          {doc.blob?.url ? (
                            <a
                              href={doc.blob.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "0.75rem", color: "#2563eb", textDecoration: "none", fontFamily: "inherit" }}
                            >
                              Open file
                            </a>
                          ) : null}
                        </div>
                      </div>
                      <pre style={{ margin: 0, padding: "0.7rem", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.82rem", color: "var(--text-2)", lineHeight: 1.5 }}>{doc.content}</pre>
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

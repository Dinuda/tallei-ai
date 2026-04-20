"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, FileText, FolderOpen, RefreshCw, Trash2 } from "lucide-react";

type DocStatus = "pending" | "ready" | "failed";

type DocListItem = {
  ref: string;
  filename: string | null;
  title: string | null;
  byteSize: number;
  status: DocStatus;
  createdAt: string;
  lotRef: string | null;
  lotTitle: string | null;
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
};

type ModalPayload =
  | {
    kind: "document";
    ref: string;
    filename: string | null;
    title: string | null;
    content: string;
    status: "ready" | "pending_embedding" | "failed_indexing";
  }
  | {
    kind: "lot";
    ref: string;
    title: string | null;
    docs: ModalDocument[];
  };

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
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [lots, setLots] = useState<LotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proRequired, setProRequired] = useState(false);

  const [selected, setSelected] = useState<ModalPayload | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
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
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

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
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: "1.3rem",
          boxShadow: "var(--shadow-sm)",
        }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem", color: "var(--text)" }}>PDF / Document Stash is Pro-only</h2>
          <p style={{ margin: "0.5rem 0 0.9rem", color: "var(--text-muted)", fontSize: "0.92rem" }}>
            Upgrade to Pro or Power to stash full documents, create lots, and recall full markdown by ref.
          </p>
          <a
            href="/api/billing/checkout?plan=pro"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.55rem 0.95rem",
              borderRadius: 10,
              textDecoration: "none",
              color: "#fff",
              background: "var(--accent)",
              fontWeight: 600,
              fontSize: "0.88rem",
            }}
          >
            Upgrade to Pro
          </a>
        </div>
      ) : loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {[1, 2, 3].map((value) => (
            <div key={value} style={{ height: 64, borderRadius: 12, border: "1px solid var(--border-light)", background: "var(--surface)" }} />
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
            overflowX: "auto",
          }}>
            <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--text)" }}>
              Documents
            </div>
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
                {docs.map((doc) => {
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
                        {(doc.filename ?? doc.title ?? "Untitled").slice(0, 64)}
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
          </section>

          <section style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflowX: "auto",
          }}>
            <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--text)" }}>
              Lots
            </div>
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
                {lots.map((lot) => (
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
                        {doc.ref}
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

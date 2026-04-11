"use client";

import { useEffect, useState } from "react";

interface ApiKey {
  id: string;
  name: string;
  lastUsed: string | null;
  createdAt: string;
  connectorType: string | null;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newlyGeneratedKey, setNewlyGeneratedKey] = useState<string | null>(null);
  const [copiedNew, setCopiedNew] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      if (!res.ok) return;
      const data = await res.json();
      setKeys(data.keys || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleGenerate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newKeyName.trim()) return;

    setGenerating(true);
    setNewlyGeneratedKey(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });

      if (!res.ok) return;

      const data = await res.json();
      setNewlyGeneratedKey(data.key);
      setNewKeyName("");
      await fetchKeys();
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (res.ok) await fetchKeys();
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  const copyNewKey = () => {
    if (!newlyGeneratedKey) return;
    navigator.clipboard.writeText(newlyGeneratedKey);
    setCopiedNew(true);
    setTimeout(() => setCopiedNew(false), 2000);
  };

  return (
    <div className="page-stack">
      <header>
        <h2 className="page-title">API Keys</h2>
        <p className="page-subtitle">Manage API keys for connecting AI platforms to your memory graph.</p>
      </header>

      <section className="panel">
        <h4 className="panel-title">Create new key</h4>

        <form onSubmit={handleGenerate}>
          <div className="inline-form-row">
            <div className="form-group">
              <label className="form-label">Key name</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. Claude Desktop Mac"
                value={newKeyName}
                onChange={(event) => setNewKeyName(event.target.value)}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={generating || !newKeyName.trim()}>
              {generating ? "Creating..." : "Generate key"}
            </button>
          </div>
        </form>

        {newlyGeneratedKey && (
          <div className="generated-key-notice animate-fade-up">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M7 1v1M7 12v1M1 7h1M12 7h1M2.8 2.8l.7.7M10.5 10.5l.7.7M2.8 11.2l.7-.7M10.5 3.5l.7-.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              <span style={{ fontWeight: 700, fontSize: "0.87rem", color: "var(--accent-dark)" }}>
                Save this key, it will not be shown again
              </span>
            </div>

            <p style={{ fontSize: "0.82rem", color: "var(--text-2)", marginBottom: "0.8rem" }}>
              For security, this key is hashed in our database and cannot be recovered.
            </p>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <div className="code-block" style={{ flex: 1 }}>{newlyGeneratedKey}</div>
              <button type="button" className="btn btn-primary btn-sm" onClick={copyNewKey}>
                {copiedNew ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h4 className="panel-title">Active keys</h4>

        {loading ? (
          <p className="page-subtitle">Loading...</p>
        ) : keys.length === 0 ? (
          <div className="empty-state-panel" style={{ minHeight: "170px" }}>
            <p className="page-subtitle">No keys yet. Create your first key above.</p>
          </div>
        ) : (
          <div className="list-stack">
            {keys.map((key) => (
              <div key={key.id} className="key-list-row">
                <div className="key-list-meta">
                  <span className="key-icon-wrap" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="5.5" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M8.5 4.5L12.5 0.5M12.5 0.5H9.5M12.5 0.5V3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>

                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                      <span className="key-name">{key.name}</span>
                      {key.connectorType && (
                        <span style={{
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          padding: "1px 7px",
                          borderRadius: "999px",
                          background: "var(--accent-light)",
                          color: "var(--accent-dark, var(--text-2))",
                          border: "1px solid var(--border)",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}>
                          {key.connectorType}
                        </span>
                      )}
                    </span>
                    <p className="key-date">
                      Created {new Date(key.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  </span>
                </div>

                <button
                  type="button"
                  className="danger-btn"
                  onClick={() => handleDelete(key.id)}
                  disabled={deletingId === key.id}
                  style={{ opacity: deletingId === key.id ? 0.55 : 1 }}
                >
                  {deletingId === key.id ? "Revoking..." : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

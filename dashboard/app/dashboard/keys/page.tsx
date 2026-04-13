"use client";

import Link from "next/link";

export default function KeysPage() {
  return (
    <div className="page-stack">
      <header style={{ marginBottom: "0.5rem" }}>
        <h2 className="page-title">API Keys</h2>
        <p className="page-subtitle">Legacy API keys are disabled after the OAuth migration.</p>
      </header>

      <div
        style={{
          border: "1px solid #1e2228",
          borderRadius: "14px",
          background: "#0d1015",
          padding: "1.25rem",
        }}
      >
        <p style={{ color: "#d1d5db", margin: 0, lineHeight: 1.6 }}>
          Use OAuth connectors from the setup flow. Existing <code>gm_*</code> keys were revoked and are no longer
          accepted by <code>/mcp</code> or connector APIs.
        </p>
        <div style={{ marginTop: "1rem" }}>
          <Link href="/dashboard/setup" className="btn btn-primary">
            Open OAuth Setup
          </Link>
        </div>
      </div>
    </div>
  );
}

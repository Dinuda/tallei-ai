"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, ExternalLink, RefreshCw } from "lucide-react";

type AuthSession = {
  id: string;
  provider: string;
  status: string;
  setupUrl: string;
  expiresAt: string;
  requiredScopes: string[];
};

export default function ConnectorSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState("");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void params.then((value) => {
      if (!cancelled) setId(value.id);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  async function load(sessionId = id) {
    if (!sessionId) return;
    setError(null);
    const res = await fetch(`/api/connectors/auth-sessions/${sessionId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Failed to load connector session");
    setSession(data);
  }

  useEffect(() => {
    if (!id) return;
    void load(id).catch((e) => setError(e instanceof Error ? e.message : "Failed to load connector session"));
  }, [id]);

  async function continueSession() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/auth-sessions/${id}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to continue connector auth");
      await load(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to continue connector auth");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">Connector setup</h1>
      <p className="mt-1 text-sm text-slate-500">{id}</p>

      {error ? <p className="mt-4 text-sm text-rose-600">{error}</p> : null}

      <section className="mt-6 border border-slate-200 bg-white p-4">
        {!session ? (
          <p className="text-sm text-slate-500">Loading setup session...</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{session.provider}</p>
              <p className="text-xs text-slate-500">
                {session.status} · expires {new Date(session.expiresAt).toLocaleString()}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={session.setupUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-2 bg-[#111827] px-3 text-sm font-medium text-white hover:opacity-85"
              >
                Open setup <ExternalLink size={14} />
              </a>
              <button
                type="button"
                onClick={() => void continueSession()}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Check size={15} /> Continue
              </button>
              <button
                type="button"
                onClick={() => void load().catch((e) => setError(e instanceof Error ? e.message : "Failed to refresh"))}
                className="inline-flex h-9 items-center gap-2 border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw size={15} /> Refresh
              </button>
            </div>
            <Link href="/dashboard/integrations" className="text-sm text-slate-600 underline underline-offset-4">
              Back to integrations
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ConnectorState =
  | "not_connected"
  | "authorizing"
  | "connected_pending_action_visibility"
  | "connected"
  | "expired"
  | "failed";

type ConnectorAccount = {
  id: string;
  status: string;
};

type Checklist = {
  requirementId: string;
  complete: boolean;
  apps: Array<{
    toolkit: string;
    name: string;
    logo: string;
    state: ConnectorState;
    accountConnected: boolean;
    accounts: ConnectorAccount[];
    selectedAccountIds: string[];
    actions: Array<{ slug: string; name: string; description: string; effect: string; available: boolean }>;
  }>;
};

type PendingAuth = {
  authSessionId: string;
  setupUrl: string;
  toolkit: string;
  requirementId: string;
};

type ResendSetupPayload = {
  provider: "resend";
  status: "connected" | "missing";
  portalUrl: string;
  apiKeysUrl: string;
  docsUrl: string;
  steps: string[];
};

const NATIVE_API_KEY_TOOLKITS = new Set(["resend"]);

const pendingKey = (sessionId: string) => `loop-builder-connector-auth:${sessionId}`;

function readPending(sessionId: string): PendingAuth | null {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(sessionId));
    return raw ? JSON.parse(raw) as PendingAuth : null;
  } catch {
    return null;
  }
}

function statusLabel(app: Checklist["apps"][number]): string {
  if (app.accountConnected) return "Connected";
  if (app.state === "authorizing") return "Connecting";
  return "Not connected";
}

export function BuilderConnectorChecklist({
  sessionId,
  requirementId,
  completed = false,
  onComplete,
}: {
  sessionId: string;
  requirementId: string;
  completed?: boolean;
  onComplete?: (output: { answerText: string; requirementId: string; value: { selections: Array<{ toolkit: string; accounts: Array<{ id: string }>; actionSlugs: string[] }> } }) => void;
}) {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [busyToolkit, setBusyToolkit] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [resendModalOpen, setResendModalOpen] = useState(false);
  const [resendSetup, setResendSetup] = useState<ResendSetupPayload | null>(null);
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendLabel, setResendLabel] = useState("");
  const resolvingRef = useRef(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/loop-builder/sessions/${sessionId}/connectors/refresh`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to refresh connector availability");
    setChecklist(payload.checklist as Checklist);
    return payload.checklist as Checklist;
  }, [sessionId]);

  const continuePending = useCallback(async () => {
    const pending = readPending(sessionId);
    if (!pending) return refresh();
    setBusyToolkit(pending.toolkit);
    const response = await fetch(`/api/connectors/auth-sessions/${pending.authSessionId}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to finish connector authorization");
    if (payload.status === "connected" || payload.status === "expired" || payload.status === "failed") {
      window.sessionStorage.removeItem(pendingKey(sessionId));
      setFallbackUrl(null);
    }
    const next = await refresh();
    setBusyToolkit(payload.status === "auth_started" ? pending.toolkit : null);
    return next;
  }, [refresh, sessionId]);

  useEffect(() => {
    if (completed) return;
    void continuePending().catch(() => {
      setError("We could not check the app connection. Please try again.");
      setBusyToolkit(null);
    });
    const onReturn = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "tallei-connector-complete") return;
      void continuePending().catch(() => setError("We could not finish connecting the app. Please try again."));
    };
    const onFocus = () => void continuePending().catch(() => undefined);
    window.addEventListener("message", onReturn);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onReturn);
      window.removeEventListener("focus", onFocus);
    };
  }, [completed, continuePending]);

  useEffect(() => {
    if (!busyToolkit || completed) return;
    const timer = window.setInterval(() => void continuePending().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, [busyToolkit, completed, continuePending]);

  async function connect(toolkit: string) {
    setError(null);
    setBusyToolkit(toolkit);
    if (NATIVE_API_KEY_TOOLKITS.has(toolkit)) {
      try {
        const response = await fetch("/api/connectors/resend", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Failed to load Resend setup");
        setResendSetup(payload as ResendSetupPayload);
        setResendApiKey("");
        setResendLabel("");
        setResendModalOpen(true);
        setBusyToolkit(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "We could not open the Resend connection dialog.");
        setBusyToolkit(null);
      }
      return;
    }
    const completionUrl = new URL("/connect/complete", window.location.origin);
    completionUrl.searchParams.set("builder_session", sessionId);
    completionUrl.searchParams.set("requirement", requirementId);
    completionUrl.searchParams.set("toolkit", toolkit);
    try {
      const response = await fetch("/api/connectors/composio/auth-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_key: toolkit,
          required_scopes: [toolkit],
          redirect_uri: completionUrl.toString(),
          workflow_builder_session_id: sessionId,
          build_requirement_id: requirementId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to start connector authorization");
      const pending = { authSessionId: payload.auth_session_id, setupUrl: payload.setup_url, toolkit, requirementId };
      window.sessionStorage.setItem(pendingKey(sessionId), JSON.stringify(pending));
      const popup = window.open(payload.setup_url, `connector-${toolkit}`, "popup=yes,width=560,height=760");
      if (!popup) setFallbackUrl(payload.setup_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not open the connection. Please try again.");
      setBusyToolkit(null);
    }
  }

  async function saveResendConnector() {
    if (!resendApiKey.trim()) {
      setError("Resend API key is required");
      return;
    }
    setError(null);
    setBusyToolkit("resend");
    try {
      const response = await fetch("/api/connectors/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: resendApiKey.trim(),
          ...(resendLabel.trim().length > 0 ? { label: resendLabel.trim() } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to connect Resend");
      setResendSetup(payload as ResendSetupPayload);
      setResendModalOpen(false);
      setResendApiKey("");
      setResendLabel("");
      await refresh();
      setBusyToolkit(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not connect Resend.");
      setBusyToolkit(null);
    }
  }

  async function confirmConnectedApps() {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setError(null);
    setBusyToolkit("confirm");
    try {
      const latest = await refresh();
      if (!latest || !latest.complete) throw new Error("Connected apps are not ready");
      const selections = latest.apps.map((app) => ({
        toolkit: app.toolkit,
        accounts: app.accounts
          .filter((account) => app.selectedAccountIds.includes(account.id))
          .map((account) => ({ id: account.id })),
        actionSlugs: app.actions.map((action) => action.slug),
      }));
      const value = { selections };
      onComplete?.({ answerText: "Use selected connected apps", requirementId, value });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not finish setting up the connected apps.");
      await refresh().catch(() => undefined);
    } finally {
      setBusyToolkit(null);
      resolvingRef.current = false;
    }
  }

  useEffect(() => {
    if (!completed && checklist?.complete) void confirmConnectedApps();
  }, [checklist?.complete, completed]);

  if (completed) {
    return (
      <div className="my-3 flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3">
        <span className="flex size-8 items-center justify-center bg-emerald-600 text-white">
          <Check className="size-4" />
        </span>
        <div>
          <div className="text-sm font-semibold text-emerald-950" style={{ fontFamily: "var(--font-title)" }}>Apps connected</div>
          <div className="text-xs text-emerald-700">The loop can use the required connected apps.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full border border-indigo-200 bg-indigo-50/40">
      <div className="border-b border-indigo-100 bg-white px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center bg-indigo-100 text-indigo-700">
              <ShieldCheck className="size-4" />
            </span>
            <div>
              <div className="flex items-center gap-2 text-[14px] font-bold tracking-[-0.02em] text-indigo-950" style={{ fontFamily: "var(--font-title)" }}>
                Connect required apps
              </div>
              <p className="mt-0.5 text-[13px] text-indigo-900/70">Connect the apps this loop needs to work.</p>
            </div>
          </div>
          <span className="border border-indigo-200 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
            {checklist?.apps.filter((app) => app.accountConnected).length ?? 0} of {checklist?.apps.length ?? 0} connected
          </span>
        </div>
      </div>

      <div className="p-4">
        {!checklist && (
          <div className="flex items-center gap-2 border border-dashed border-indigo-200 bg-white px-4 py-5 text-sm text-indigo-900/70">
            <LoaderCircle className="size-4 animate-spin" /> Checking connected accounts...
          </div>
        )}
        {checklist?.complete && checklist.apps.length === 0 && (
          <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-4 py-5 text-sm text-emerald-800">
            <LoaderCircle className="size-4 animate-spin" /> Platform apps are ready — continuing...
          </div>
        )}
        {checklist && !checklist.complete && checklist.apps.length === 0 && (
          <div className="flex items-center gap-2 border border-dashed border-indigo-200 bg-white px-4 py-5 text-sm text-indigo-900/70">
            <LoaderCircle className="size-4 animate-spin" /> Checking connected accounts...
          </div>
        )}
        {checklist?.apps.map((app) => {
          const open = expanded.includes(app.toolkit);
          const busy = busyToolkit === app.toolkit;
          return (
            <div className="border-b border-indigo-100 bg-white last:border-b-0" key={app.toolkit}>
              <div className="flex w-full items-center gap-3 p-4 text-left">
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden border border-indigo-100 bg-white">
                  <img alt="" className="size-7 object-contain" src={app.logo || `https://logos.composio.dev/api/${app.toolkit}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-indigo-950" style={{ fontFamily: "var(--font-title)" }}>{app.name}</span>
                    <span className={cn(
                      "border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      app.accountConnected
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                    )}>
                      {statusLabel(app)}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-indigo-900/70">
                    {app.accountConnected ? "Ready to use" : "Connection required"}
                  </span>
                </span>
                {app.accountConnected && (
                  <span className="flex size-8 items-center justify-center bg-emerald-600 text-white">
                    <Check className="size-4" />
                  </span>
                )}
                {!app.accountConnected && (
                  <Button
                    className="bg-indigo-700 text-white hover:bg-indigo-800"
                    disabled={busy}
                    onClick={() => void connect(app.toolkit)}
                    size="sm"
                    style={{ borderRadius: 0 }}
                  >
                    {busy ? <LoaderCircle className="size-4 animate-spin" /> : "Connect"}
                  </Button>
                )}
                <button
                  aria-label={`${open ? "Hide" : "Show"} ${app.name} details`}
                  className="flex size-8 items-center justify-center text-indigo-900/70 transition-colors hover:bg-indigo-50 hover:text-indigo-950"
                  onClick={() => setExpanded((current) => current.includes(app.toolkit) ? current.filter((item) => item !== app.toolkit) : [...current, app.toolkit])}
                  type="button"
                >
                  {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                </button>
              </div>

              {open && (
                <div className="border-t border-indigo-100 bg-indigo-50/60 px-4 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-indigo-700" style={{ fontFamily: "var(--font-title)" }}>
                    What this loop can do with {app.name}
                  </p>
                  <div className="mt-2 space-y-2">
                    {app.actions.map((action) => (
                      <div className="flex items-start gap-2 text-xs" key={action.slug}>
                        <Check className="mt-0.5 size-3 text-emerald-600" />
                        <div>
                          <div className="font-medium text-indigo-950">{action.name}</div>
                          <div className="text-indigo-900/70">{action.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {fallbackUrl && (
        <a className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 underline underline-offset-4" href={fallbackUrl} rel="noreferrer" target="_blank">
          Open authorization <ExternalLink className="size-3" />
        </a>
      )}
      {error && <p className="mt-3 border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      {resendModalOpen && resendSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setResendModalOpen(false)}>
          <div className="w-full max-w-md border border-indigo-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4">
              <h3 className="text-base font-bold text-indigo-950" style={{ fontFamily: "var(--font-title)" }}>Connect Resend</h3>
              <p className="mt-1 text-sm text-indigo-900/70">Resend uses your own API key — not OAuth.</p>
            </div>
            <ol className="mb-4 list-decimal space-y-1 pl-5 text-xs text-indigo-900/80">
              {resendSetup.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            <div className="mb-3 flex flex-wrap gap-2">
              <a className="border border-indigo-200 px-2 py-1 text-xs text-indigo-700 underline" href={resendSetup.portalUrl} rel="noreferrer" target="_blank">Resend dashboard</a>
              <a className="border border-indigo-200 px-2 py-1 text-xs text-indigo-700 underline" href={resendSetup.apiKeysUrl} rel="noreferrer" target="_blank">Create API key</a>
            </div>
            <label className="mb-3 block text-xs font-medium text-indigo-950" htmlFor="builder-resend-label">Label (optional)</label>
            <input
              className="mb-3 w-full border border-indigo-200 px-3 py-2 text-sm"
              id="builder-resend-label"
              onChange={(event) => setResendLabel(event.target.value)}
              placeholder="Marketing account"
              value={resendLabel}
            />
            <label className="mb-1 block text-xs font-medium text-indigo-950" htmlFor="builder-resend-api-key">API key</label>
            <input
              autoComplete="off"
              className="mb-4 w-full border border-indigo-200 px-3 py-2 text-sm"
              id="builder-resend-api-key"
              onChange={(event) => setResendApiKey(event.target.value)}
              placeholder="re_..."
              type="password"
              value={resendApiKey}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setResendModalOpen(false)} size="sm" style={{ borderRadius: 0 }} variant="outline">Cancel</Button>
              <Button className="bg-indigo-700 text-white hover:bg-indigo-800" disabled={busyToolkit === "resend"} onClick={() => void saveResendConnector()} size="sm" style={{ borderRadius: 0 }}>
                {busyToolkit === "resend" ? <LoaderCircle className="size-4 animate-spin" /> : "Save and connect"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {busyToolkit === "confirm" && (
        <div className="mt-4 flex items-center justify-end gap-2 text-xs text-indigo-900/70">
          <LoaderCircle className="size-4 animate-spin" /> Continuing...
        </div>
      )}
    </div>
  );
}

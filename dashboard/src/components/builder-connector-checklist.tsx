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
  onComplete?: (output: { answerText: string; requirementId: string }) => void;
}) {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [busyToolkit, setBusyToolkit] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
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

  async function confirmConnectedApps() {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setError(null);
    setBusyToolkit("confirm");
    try {
      const response = await fetch(`/api/loop-builder/sessions/${sessionId}/connectors/resolve`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Connected apps are not ready");
      onComplete?.({ answerText: "Use selected connected apps", requirementId });
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
      <div className="my-3 flex items-center gap-3 border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm">
        <span className="flex size-8 items-center justify-center bg-emerald-600 text-white"><Check className="size-4" /></span>
        <div><div className="font-medium text-emerald-950">Apps connected</div><div className="text-xs text-emerald-700">The loop can use the required connected apps.</div></div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-3xl border border-[#e8e5f0] bg-[#f9f8fc] px-4 py-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-indigo-700" /> Connect required apps</div>
          <p className="mt-1 text-xs text-[#77738c]">Connect the apps this loop needs to work.</p>
        </div>
        <span className="rounded-full border border-[#ded9f1] bg-white px-3 py-1 text-[11px] font-medium text-[#6d6883]">{checklist?.apps.filter((app) => app.accountConnected).length ?? 0} of {checklist?.apps.length ?? 0} connected</span>
      </div>

      <div className="mt-4 space-y-3">
        {!checklist && <div className="flex items-center gap-2 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-5 text-sm text-[#77738c]"><LoaderCircle className="size-4 animate-spin" /> Checking connected accounts...</div>}
        {checklist?.apps.map((app) => {
          const open = expanded.includes(app.toolkit);
          const busy = busyToolkit === app.toolkit;
          return (
            <div className="overflow-hidden rounded-2xl border border-[#e8e5f0] bg-white" key={app.toolkit}>
              <div className="flex w-full items-center gap-3 p-4 text-left">
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#ece9f5] bg-white"><img alt="" className="size-7 object-contain" src={app.logo || `https://logos.composio.dev/api/${app.toolkit}`} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{app.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", app.accountConnected ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600")}>{statusLabel(app)}</span></span>
                  <span className="mt-1 block truncate text-xs text-[#77738c]">{app.accountConnected ? "Ready to use" : "Connection required"}</span>
                </span>
                {app.accountConnected && <span className="flex size-8 items-center justify-center rounded-full bg-emerald-600 text-white"><Check className="size-4" /></span>}
                {!app.accountConnected && <Button disabled={busy} onClick={() => void connect(app.toolkit)} size="sm">{busy ? <LoaderCircle className="size-4 animate-spin" /> : "Connect"}</Button>}
                <button
                  aria-label={`${open ? "Hide" : "Show"} ${app.name} details`}
                  className="flex size-8 items-center justify-center rounded-full text-[#77738c] hover:bg-slate-100"
                  onClick={() => setExpanded((current) => current.includes(app.toolkit) ? current.filter((item) => item !== app.toolkit) : [...current, app.toolkit])}
                  type="button"
                >
                  {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                </button>
              </div>

              {open && <div className="border-t border-[#eeeaf6] bg-[#fbfaff] px-4 py-4">
                <p className="text-xs font-medium text-[#77738c]">What this loop can do with {app.name}</p>
                <div className="mt-2 space-y-2">
                  {app.actions.map((action) => <div className="flex items-start gap-2 text-xs" key={action.slug}><Check className="mt-0.5 size-3 text-emerald-600" /><div><div className="font-medium text-slate-800">{action.name}</div><div className="text-[#77738c]">{action.description}</div></div></div>)}
                </div>
              </div>}
            </div>
          );
        })}
      </div>

      {fallbackUrl && <a className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 underline underline-offset-4" href={fallbackUrl} rel="noreferrer" target="_blank">Open authorization <ExternalLink className="size-3" /></a>}
      {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      {busyToolkit === "confirm" && <div className="mt-4 flex items-center justify-end gap-2 text-xs text-[#77738c]"><LoaderCircle className="size-4 animate-spin" /> Continuing...</div>}
    </div>
  );
}

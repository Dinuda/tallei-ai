"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  Trash2,
  Sparkles,
  X,
  Zap,
  Plus,
  Command,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import styles from "./page.module.css";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
type ConnectorAccount = {
  id: string;
  provider: string;
  appKey?: string | null;
  externalAccountId: string;
  status: string;
  scopes: string[];
  updatedAt: string;
};

type AppCategory =
  | "All"
  | "Communication"
  | "Scheduling"
  | "Social"
  | "Development"
  | "Productivity"
  | "Storage";

type AppDef = {
  key: string;
  name: string;
  description: string;
  category: AppCategory;
  scopes: string[];
  color: string;
  logo: string;
  authMode?: "composio" | "native_api_key";
};

type ComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  logo: string;
};

/* ------------------------------------------------------------------ */
/* Static metadata merged with Composio toolkit data                  */
/* ------------------------------------------------------------------ */
function normalizeComposioSlug(slug: string): string {
  const map: Record<string, string> = {
    google_calendar: "googlecalendar",
    microsoft_teams: "msteams",
    microsoft_outlook: "outlook",
    microsoft_onedrive: "onedrive",
    google_drive: "gdrive",
  };
  return map[slug] ?? slug;
}

const APP_META: Record<
  string,
  { scopes: string[]; color: string; category: AppCategory; authMode?: "composio" | "native_api_key" }
> = {
  resend: { scopes: ["resend.send_email"], color: "#000000", category: "Communication", authMode: "native_api_key" },
  gmail: { scopes: ["gmail.send_email"], color: "#EA4335", category: "Communication" },
  slack: { scopes: ["slack.post_message"], color: "#4A154B", category: "Communication" },
  msteams: { scopes: [], color: "#6264A7", category: "Communication" },
  discord: { scopes: [], color: "#5865F2", category: "Communication" },
  googlecalendar: { scopes: ["googlecalendar.create_event"], color: "#4285F4", category: "Scheduling" },
  outlook: { scopes: [], color: "#0078D4", category: "Scheduling" },
  calendly: { scopes: [], color: "#006BFF", category: "Scheduling" },
  twitter: { scopes: [], color: "#000000", category: "Social" },
  linkedin: { scopes: [], color: "#0A66C2", category: "Social" },
  github: { scopes: ["github.create_issue"], color: "#181717", category: "Development" },
  gitlab: { scopes: [], color: "#FC6D26", category: "Development" },
  linear: { scopes: [], color: "#5E6AD2", category: "Development" },
  jira: { scopes: [], color: "#0052CC", category: "Development" },
  notion: { scopes: ["notion.create_page"], color: "#000000", category: "Productivity" },
  asana: { scopes: [], color: "#F06A6A", category: "Productivity" },
  trello: { scopes: [], color: "#0079BF", category: "Productivity" },
  gdrive: { scopes: [], color: "#34A853", category: "Storage" },
  dropbox: { scopes: [], color: "#0061FF", category: "Storage" },
  onedrive: { scopes: [], color: "#0078D4", category: "Storage" },
};

const CATEGORIES: AppCategory[] = [
  "All",
  "Communication",
  "Scheduling",
  "Social",
  "Development",
  "Productivity",
  "Storage",
];

const RECOMMENDED_KEYS = ["resend", "gmail", "slack", "googlecalendar", "github", "notion"];

const PENDING_CONNECTOR_KEY = "tallei:pending-connector-auth";

type PendingConnectorAuth = {
  appKey: string;
  authSessionId?: string;
  scopes?: string[];
  startedAt: number;
};

type ResendSetupPayload = {
  provider: "resend";
  status: "connected" | "missing";
  portalUrl: string;
  apiKeysUrl: string;
  docsUrl: string;
  steps: string[];
  connection?: {
    id: string;
    status: string;
    last4: string | null;
    label: string | null;
  };
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function inferAppKeyFromScopes(scopes: string[]): string | null {
  const first = scopes.find((scope) => scope.trim().length > 0)?.trim().toLowerCase();
  if (!first) return null;

  if (first.startsWith("https://www.googleapis.com/auth/")) {
    const service = first.replace("https://www.googleapis.com/auth/", "").split(".")[0];
    if (service === "gmail" || service === "mail") return "gmail";
    if (service === "calendar") return "googlecalendar";
    return service || null;
  }

  if (first.includes("google.com") || first.includes("googleapis.com")) {
    if (first.includes("mail")) return "gmail";
    if (first.includes("calendar")) return "googlecalendar";
    return "google";
  }

  return first.split(/[.:/]/)[0] || null;
}

function resolveConnectorKey(account: ConnectorAccount): string | null {
  const metadataKey = typeof account.appKey === "string" ? account.appKey.trim().toLowerCase() : "";
  if (metadataKey.length > 0) return metadataKey;
  const providerKey = account.provider.trim().toLowerCase();
  if (providerKey.length > 0 && providerKey !== "composio") return providerKey;
  return inferAppKeyFromScopes(account.scopes);
}

function readPendingConnectorAuth(): PendingConnectorAuth | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingConnectorAuth>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.appKey !== "string" || parsed.appKey.trim().length === 0) return null;
    return {
      appKey: parsed.appKey,
      authSessionId: typeof parsed.authSessionId === "string" ? parsed.authSessionId : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((v): v is string => typeof v === "string") : undefined,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function useKeydown(key: string, handler: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === key) handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, handler]);
}

function mergeApps(toolkits: ComposioToolkit[]): AppDef[] {
  const seen = new Set<string>();
  const apps: AppDef[] = [];

  for (const tk of toolkits) {
    const key = normalizeComposioSlug(tk.slug);
    if (seen.has(key)) continue;
    seen.add(key);

    const meta = APP_META[key];
    apps.push({
      key,
      name: tk.name || key,
      description: tk.description || "",
      category: meta?.category ?? "Productivity",
      scopes: meta?.scopes ?? [],
      color: meta?.color ?? "#7a9a4a",
      logo: tk.logo || "",
      authMode: meta?.authMode,
    });
  }

  // Add any statically-defined apps that Composio didn't return
  for (const [key, meta] of Object.entries(APP_META)) {
    if (seen.has(key)) continue;
    apps.push({
      key,
      name: key,
      description: "",
      category: meta.category,
      scopes: meta.scopes,
      color: meta.color,
      logo: "",
      authMode: meta.authMode,
    });
  }

  return apps;
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */
export default function ConnectedAppsPage() {
  const [connectors, setConnectors] = useState<ConnectorAccount[]>([]);
  const [apps, setApps] = useState<AppDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [resendModalOpen, setResendModalOpen] = useState(false);
  const [resendSetup, setResendSetup] = useState<ResendSetupPayload | null>(null);
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendLabel, setResendLabel] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  async function load(options?: { connectionCheck?: boolean }) {
    setError(null);
    if (options?.connectionCheck) setCheckingConnection(true);
    try {
      const [connectorsRes, toolkitsRes] = await Promise.all([
        fetch("/api/connectors", { cache: "no-store" }),
        fetch("/api/connectors/composio/toolkits", { cache: "no-store" }),
      ]);

      const connectorsData = await connectorsRes.json();
      const toolkitsData = await toolkitsRes.json();

      if (!connectorsRes.ok) throw new Error(connectorsData?.error || "Failed to load connected apps");
      setConnectors(Array.isArray(connectorsData.connectors) ? connectorsData.connectors : []);

      const toolkits = Array.isArray(toolkitsData.toolkits) ? toolkitsData.toolkits : [];
      setApps(mergeApps(toolkits));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connected apps");
    } finally {
      setLoading(false);
      setRefreshing(false);
      if (options?.connectionCheck) setCheckingConnection(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedFromAuth = params.get("connector_return") === "1";
    const pendingAuth = readPendingConnectorAuth();
    const hadPendingAuth = pendingAuth !== null;
    const shouldCheckConnection = returnedFromAuth || hadPendingAuth;

    async function continuePendingAuth(pending: PendingConnectorAuth): Promise<void> {
      if (!pending.authSessionId) return;
      await fetch(`/api/connectors/auth-sessions/${pending.authSessionId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes: pending.scopes ?? [pending.appKey],
        }),
      });
    }

    if (returnedFromAuth) {
      params.delete("connector_return");
      params.delete("app");
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    async function checkAndLoad(pending: PendingConnectorAuth | null) {
      if (pending) {
        try {
          await continuePendingAuth(pending);
        } catch {
          // best effort: load status from backend regardless
        } finally {
          window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
        }
      }

      if (shouldCheckConnection) {
        setRefreshing(true);
        await load({ connectionCheck: true });
      } else {
        await load();
      }
    }

    void checkAndLoad(pendingAuth);

    function checkPendingConnection() {
      if (document.visibilityState !== "visible") return;
      const pending = readPendingConnectorAuth();
      if (!pending) return;
      void checkAndLoad(pending);
    }

    window.addEventListener("focus", checkPendingConnection);
    document.addEventListener("visibilitychange", checkPendingConnection);
    return () => {
      window.removeEventListener("focus", checkPendingConnection);
      document.removeEventListener("visibilitychange", checkPendingConnection);
    };
  }, []);

  const connectedApps = useMemo(() => {
    return connectors
      .map((c) => {
        const app = apps.find((a) => a.key === resolveConnectorKey(c));
        return app ? { ...c, app } : null;
      })
      .filter(Boolean) as (ConnectorAccount & { app: AppDef })[];
  }, [connectors, apps]);

  const recommendedApps = useMemo(() => {
    const connectedKeys = new Set(connectors.map((c) => resolveConnectorKey(c)).filter((k): k is string => !!k));
    return apps.filter((a) => RECOMMENDED_KEYS.includes(a.key) && !connectedKeys.has(a.key));
  }, [connectors, apps]);

  async function startAuth(app: AppDef) {
    if (app.authMode === "native_api_key" && app.key === "resend") {
      setResendBusy(true);
      setResendError(null);
      setResendApiKey("");
      setResendLabel("");
      try {
        const res = await fetch("/api/connectors/resend", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load Resend setup");
        setResendSetup(data as ResendSetupPayload);
        setResendModalOpen(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load Resend setup");
      } finally {
        setResendBusy(false);
      }
      return;
    }

    setBusyKey(app.key);
    setError(null);
    try {
      const redirectUrl = new URL("/dashboard/integrations", window.location.origin);
      redirectUrl.searchParams.set("connector_return", "1");
      redirectUrl.searchParams.set("app", app.key);
      window.sessionStorage.setItem(
        PENDING_CONNECTOR_KEY,
        JSON.stringify({ appKey: app.key, startedAt: Date.now() })
      );

      const res = await fetch("/api/connectors/composio/auth-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_key: app.key,
          required_scopes: app.scopes,
          redirect_uri: redirectUrl.toString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to start connection");
      const authSessionId = typeof data?.auth_session_id === "string" ? data.auth_session_id : null;
      const nextSetupUrl = typeof data?.setup_url === "string" ? data.setup_url : null;
      if (!nextSetupUrl) throw new Error("Missing setup URL from connector response");
      if (authSessionId) {
        window.sessionStorage.setItem(
          PENDING_CONNECTOR_KEY,
          JSON.stringify({
            appKey: app.key,
            authSessionId,
            scopes: app.scopes,
            startedAt: Date.now(),
          } satisfies PendingConnectorAuth)
        );
      }
      window.location.assign(nextSetupUrl);
    } catch (e) {
      window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
      setError(e instanceof Error ? e.message : "Failed to start connection");
      setBusyKey(null);
    }
  }

  async function saveResendConnector() {
    if (!resendApiKey.trim()) {
      setResendError("Resend API key is required");
      return;
    }
    setResendBusy(true);
    setResendError(null);
    try {
      const res = await fetch("/api/connectors/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: resendApiKey.trim(),
          ...(resendLabel.trim().length > 0 ? { label: resendLabel.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to connect Resend");
      setResendSetup(data as ResendSetupPayload);
      setResendModalOpen(false);
      setResendApiKey("");
      setResendLabel("");
      await load();
    } catch (e) {
      setResendError(e instanceof Error ? e.message : "Failed to connect Resend");
    } finally {
      setResendBusy(false);
    }
  }

  async function disconnect(accountId: string) {
    setBusyKey(`disconnect-${accountId}`);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/${accountId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to disconnect");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Connected Apps</h1>
          <p className={styles.pageSubtitle}>
            Link your favorite tools so Tallei can act on your behalf.
          </p>
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => {
              setRefreshing(true);
              void load();
            }}
            disabled={loading || refreshing}
            title="Refresh connections"
          >
            <RefreshCw size={16} className={refreshing ? styles.spin : ""} />
          </button>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} />
            Add app
          </button>
        </div>
      </header>

      {error ? (
        <div className={styles.bannerError}>
          <XCircle size={14} />
          {error}
        </div>
      ) : null}

      {checkingConnection ? (
        <div className={styles.setupBanner}>
          <RefreshCw size={14} className={styles.spin} />
          Checking connection status...
        </div>
      ) : null}

      {/* Connected apps */}
      <section>
        {loading ? (
          <div className={styles.connectedGrid}>
            {[1, 2].map((i) => (
              <div key={i} className={styles.skeletonConnected}>
                <div className={`${styles.skeleton} ${styles.skeletonCircle}`} />
                <div className={styles.skeletonCol}>
                  <div className={`${styles.skeleton} ${styles.skeletonLineShort}`} />
                  <div className={`${styles.skeleton} ${styles.skeletonLineTiny}`} />
                </div>
              </div>
            ))}
          </div>
        ) : connectedApps.length === 0 ? (
          <div className={styles.emptyConnected}>
            <div className={styles.emptyConnectedIcon}>
              <Zap size={24} />
            </div>
            <h3 className={styles.emptyConnectedTitle}>No apps connected</h3>
            <p className={styles.emptyConnectedText}>
              Connect apps so Tallei can read, write, and act across your tools.
            </p>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => setAddOpen(true)}
            >
              <Plus size={16} />
              Add your first app
            </button>
          </div>
        ) : (
          <div className={styles.connectedGrid}>
            {connectedApps.map((account) => {
              const app = account.app;
              const isBusy = busyKey === `disconnect-${account.id}`;
              return (
                <div key={account.id} className={styles.connectedCard}>
                  <div className={styles.connectedCardLeft}>
                    <div className={styles.connectedIconWrap}>
                      {app.logo ? (
                        <img src={app.logo} alt={app.name} />
                      ) : (
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: app.color,
                            textTransform: "uppercase",
                          }}
                        >
                          {app.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className={styles.connectedInfo}>
                      <span className={styles.connectedName}>{app.name}</span>
                      <span className={styles.connectedId}>
                        {account.externalAccountId}
                      </span>
                    </div>
                  </div>
                  <div className={styles.connectedCardRight}>
                    <span className={`${styles.statusPill} ${styles.statusConnected}`}>
                      <CheckCircle2 size={10} />
                      Connected
                    </span>
                    <button
                      type="button"
                      className={styles.disconnectIconBtn}
                      onClick={() => void disconnect(account.id)}
                      disabled={isBusy || busyKey !== null}
                      title="Disconnect"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recommended */}
      {recommendedApps.length > 0 && !loading && (
        <section className={styles.recommendedSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Recommended</h2>
            <p className={styles.sectionSubtitle}>Popular apps to get started</p>
          </div>
          <div className={styles.recommendedGrid}>
            {recommendedApps.map((app) => {
              const isBusy = busyKey === app.key;
              const isComingSoon = app.authMode !== "native_api_key" && app.scopes.length === 0;
              return (
                <div key={app.key} className={styles.recommendedCard}>
                  <div className={styles.recommendedTop}>
                    <div className={styles.recommendedIconWrap}>
                      {app.logo ? (
                        <img src={app.logo} alt={app.name} />
                      ) : (
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: app.color,
                            textTransform: "uppercase",
                          }}
                        >
                          {app.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className={styles.recommendedMeta}>
                      <span className={styles.recommendedName}>{app.name}</span>
                      <span className={styles.recommendedCategory}>{app.category}</span>
                    </div>
                  </div>
                  <p className={styles.recommendedDesc}>{app.description}</p>
                  <div className={styles.recommendedFooter}>
                    {isComingSoon ? (
                      <span className={`${styles.statusPill} ${styles.statusSoon}`}>
                        <Sparkles size={10} />
                        Coming soon
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.connectMiniBtn}
                        onClick={() => void startAuth(app)}
                        disabled={isBusy || busyKey !== null}
                      >
                        {isBusy ? "Connecting..." : "Connect"}
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Add App Drawer */}
      {addOpen && (
        <AddAppDrawer
          apps={apps}
          onClose={() => setAddOpen(false)}
          connectedKeys={new Set(connectors.map((c) => resolveConnectorKey(c)).filter((k): k is string => !!k))}
          busyKey={busyKey}
          onConnect={startAuth}
          onDisconnect={(accountId) => void disconnect(accountId)}
          connectors={connectors}
        />
      )}

      {resendModalOpen && resendSetup && (
        <div className={styles.drawerOverlay} onClick={() => setResendModalOpen(false)}>
          <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.drawerHeader}>
              <div>
                <h2 className={styles.drawerTitle}>Connect Resend</h2>
                <p className={styles.drawerSubtitle}>Use your own Resend API key for sending.</p>
              </div>
              <button type="button" className={styles.drawerClose} onClick={() => setResendModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className={styles.drawerList}>
              <div className={styles.drawerRow}>
                <div className={styles.drawerRowLeft}>
                  <div className={styles.drawerRowInfo}>
                    <div className={styles.drawerRowHead}>
                      <span className={styles.drawerRowName}>Steps</span>
                    </div>
                    <ol style={{ margin: "8px 0 0 18px", color: "var(--muted-foreground)" }}>
                      {resendSetup.steps.map((step, index) => (
                        <li key={`${index}-${step}`} style={{ marginBottom: 6 }}>{step}</li>
                      ))}
                    </ol>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <a className={styles.connectMiniBtn} href={resendSetup.portalUrl} target="_blank" rel="noreferrer">
                        Open Portal <ExternalLink size={12} />
                      </a>
                      <a className={styles.connectMiniBtn} href={resendSetup.apiKeysUrl} target="_blank" rel="noreferrer">
                        API Keys <ExternalLink size={12} />
                      </a>
                      <a className={styles.connectMiniBtn} href={resendSetup.docsUrl} target="_blank" rel="noreferrer">
                        Docs <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.drawerRow}>
                <div className={styles.drawerRowLeft}>
                  <div className={styles.drawerRowInfo}>
                    <label className={styles.drawerRowName} htmlFor="resend-label">Label (optional)</label>
                    <input
                      id="resend-label"
                      className={styles.drawerSearchInput}
                      value={resendLabel}
                      onChange={(e) => setResendLabel(e.target.value)}
                      placeholder="Production key"
                    />
                  </div>
                </div>
              </div>

              <div className={styles.drawerRow}>
                <div className={styles.drawerRowLeft}>
                  <div className={styles.drawerRowInfo}>
                    <label className={styles.drawerRowName} htmlFor="resend-api-key">API key</label>
                    <input
                      id="resend-api-key"
                      type="password"
                      className={styles.drawerSearchInput}
                      value={resendApiKey}
                      onChange={(e) => setResendApiKey(e.target.value)}
                      placeholder="re_xxxxxxxxx"
                    />
                    {resendError ? <p style={{ marginTop: 8, color: "#dc2626", fontSize: 12 }}>{resendError}</p> : null}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12 }}>
              <button type="button" className={styles.refreshBtn} onClick={() => setResendModalOpen(false)} disabled={resendBusy}>
                Cancel
              </button>
              <button type="button" className={styles.addBtn} onClick={() => void saveResendConnector()} disabled={resendBusy}>
                {resendBusy ? "Saving..." : "Save and connect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add App Drawer                                                      */
/* ------------------------------------------------------------------ */
function AddAppDrawer({
  apps,
  onClose,
  connectedKeys,
  busyKey,
  onConnect,
  onDisconnect,
  connectors,
}: {
  apps: AppDef[];
  onClose: () => void;
  connectedKeys: Set<string>;
  busyKey: string | null;
  onConnect: (app: AppDef) => void;
  onDisconnect: (accountId: string) => void;
  connectors: ConnectorAccount[];
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<AppCategory>("All");

  useKeydown("Escape", onClose);

  const filtered = useMemo(() => {
    let list = apps;
    if (activeCategory !== "All") list = list.filter((a) => a.category === activeCategory);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q)
      );
    }
    return list;
  }, [activeCategory, search, apps]);

  const connectedAccountByKey = useMemo(() => {
    const map = new Map<string, ConnectorAccount>();
    for (const c of connectors) {
      const key = resolveConnectorKey(c);
      if (key) map.set(key, c);
    }
    return map;
  }, [connectors]);

  return (
    <div className={styles.drawerOverlay} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <div>
            <h2 className={styles.drawerTitle}>Add integration</h2>
            <p className={styles.drawerSubtitle}>Browse and connect your tools</p>
          </div>
          <button type="button" className={styles.drawerClose} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.drawerSearchWrap}>
          <Search size={15} className={styles.drawerSearchIcon} />
          <input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.drawerSearchInput}
            autoFocus
          />
          <div className={styles.drawerKbd}>
            <Command size={10} />
            <span>K</span>
          </div>
        </div>

        <div className={styles.drawerTabs}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={`${styles.drawerTab} ${activeCategory === cat ? styles.drawerTabActive : ""}`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className={styles.drawerList}>
          {filtered.length === 0 ? (
            <div className={styles.drawerEmpty}>
              <Search size={32} className={styles.drawerEmptyIcon} />
              <p className={styles.drawerEmptyTitle}>No apps found</p>
              <p className={styles.drawerEmptyText}>Try a different search or category.</p>
            </div>
          ) : (
            filtered.map((app) => {
              const connected = connectedKeys.has(app.key);
              const account = connectedAccountByKey.get(app.key);
              const isBusy = busyKey === app.key || (account && busyKey === `disconnect-${account.id}`);
              const isComingSoon = app.authMode !== "native_api_key" && app.scopes.length === 0;

              return (
                <div key={app.key} className={styles.drawerRow}>
                  <div className={styles.drawerRowLeft}>
                    <div className={styles.drawerRowIcon}>
                      {app.logo ? (
                        <img src={app.logo} alt={app.name} />
                      ) : (
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: app.color,
                            textTransform: "uppercase",
                          }}
                        >
                          {app.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className={styles.drawerRowInfo}>
                      <div className={styles.drawerRowHead}>
                        <span className={styles.drawerRowName}>{app.name}</span>
                        {connected ? (
                          <span className={`${styles.statusPill} ${styles.statusConnected}`}>
                            <CheckCircle2 size={10} />
                            Connected
                          </span>
                        ) : isComingSoon ? (
                          <span className={`${styles.statusPill} ${styles.statusSoon}`}>
                            <Sparkles size={10} />
                            Coming soon
                          </span>
                        ) : null}
                      </div>
                      <p className={styles.drawerRowDesc}>{app.description}</p>
                    </div>
                  </div>
                  <div className={styles.drawerRowRight}>
                    {connected && account ? (
                      <button
                        type="button"
                        className={styles.disconnectIconBtn}
                        onClick={() => onDisconnect(account.id)}
                        disabled={isBusy || busyKey !== null}
                        title="Disconnect"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : isComingSoon ? (
                      <span className={styles.comingSoonLabel}>Coming soon</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.connectMiniBtn}
                        onClick={() => onConnect(app)}
                        disabled={isBusy || busyKey !== null}
                      >
                        {isBusy ? "..." : "Connect"}
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

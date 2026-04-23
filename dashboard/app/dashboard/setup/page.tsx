"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatGPTWizard, ClaudeWizard, Provider } from "./SetupWizards";
import styles from "./page.module.css";

type IntegrationState = "checking" | "connecting" | "connected" | "error" | "not_connected";

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  canDisconnect: boolean;
};

type IntegrationStatusMap = {
  claude: IntegrationStatus;
  chatgpt: IntegrationStatus;
};

type ChatGptTokenStatus = {
  loading: boolean;
  hasActiveToken: boolean;
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  lastTokenUsedAt: string | null;
  maskedToken: string | null;
  rawToken: string | null;
};

type ConnectorId = Provider | "gemini";

type ConnectorCard = {
  id: ConnectorId;
  name: string;
  description: string;
  icon: string;
  comingSoon?: boolean;
};

const CONNECTORS: ConnectorCard[] = [
  {
    id: "claude",
    name: "Claude",
    description: "Connect Claude projects and keep instructions synced.",
    icon: "/claude.svg",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "Connect ChatGPT Actions with secure bearer auth.",
    icon: "/chatgpt.svg",
  },
  {
    id: "gemini",
    name: "Gemini",
    description: "Native Gemini connector and setup flow.",
    icon: "/gemini.svg",
    comingSoon: true,
  },
];

const DEFAULT_STATUS: IntegrationStatus = {
  state: "not_connected",
  connected: false,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  canDisconnect: false,
};

const DEFAULT_STATUS_MAP: IntegrationStatusMap = {
  claude: { ...DEFAULT_STATUS },
  chatgpt: { ...DEFAULT_STATUS },
};

const DEFAULT_CHATGPT_TOKEN_STATUS: ChatGptTokenStatus = {
  loading: true,
  hasActiveToken: false,
  activeTokenCount: 0,
  lastTokenCreatedAt: null,
  lastTokenUsedAt: null,
  maskedToken: null,
  rawToken: null,
};

function normalizeState(value: unknown): IntegrationState {
  if (
    value === "checking" ||
    value === "connecting" ||
    value === "connected" ||
    value === "error" ||
    value === "not_connected"
  ) {
    return value;
  }
  return "not_connected";
}

function normalizeIntegrationStatus(input: unknown): IntegrationStatus {
  if (!input || typeof input !== "object") return { ...DEFAULT_STATUS };
  const value = input as Partial<IntegrationStatus>;
  return {
    state: normalizeState(value.state),
    connected: Boolean(value.connected),
    lastConnectedAt: typeof value.lastConnectedAt === "string" ? value.lastConnectedAt : null,
    lastEventAt: typeof value.lastEventAt === "string" ? value.lastEventAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    canDisconnect: Boolean(value.canDisconnect),
  };
}

function normalizeChatGptTokenStatus(input: unknown): ChatGptTokenStatus {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_CHATGPT_TOKEN_STATUS, loading: false };
  }
  const value = input as Partial<ChatGptTokenStatus>;
  return {
    loading: false,
    hasActiveToken: Boolean(value.hasActiveToken),
    activeTokenCount:
      typeof value.activeTokenCount === "number" && Number.isFinite(value.activeTokenCount)
        ? value.activeTokenCount
        : 0,
    lastTokenCreatedAt: typeof value.lastTokenCreatedAt === "string" ? value.lastTokenCreatedAt : null,
    lastTokenUsedAt: typeof value.lastTokenUsedAt === "string" ? value.lastTokenUsedAt : null,
    maskedToken: typeof value.maskedToken === "string" ? value.maskedToken : null,
    rawToken: typeof value.rawToken === "string" ? value.rawToken : null,
  };
}

function formatTimeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function stateMeta(status: IntegrationStatus): { label: string; toneClass: string; detail: string } {
  if (status.state === "connected") {
    return {
      label: "Connected",
      toneClass: styles.statusConnected,
      detail: status.lastConnectedAt
        ? `Last active ${formatTimeAgo(status.lastConnectedAt) ?? "recently"}`
        : "Ready to use",
    };
  }
  if (status.state === "connecting" || status.state === "checking") {
    return {
      label: "Connecting",
      toneClass: styles.statusConnecting,
      detail: "Finish setup to activate this connector",
    };
  }
  if (status.state === "error") {
    return {
      label: "Needs attention",
      toneClass: styles.statusError,
      detail: status.lastError || "Setup needs a quick repair",
    };
  }
  return {
    label: "Not connected",
    toneClass: styles.statusIdle,
    detail: "Run setup wizard to connect",
  };
}

export default function ConnectorsPage() {
  const [statusByProvider, setStatusByProvider] = useState<IntegrationStatusMap>(DEFAULT_STATUS_MAP);
  const [chatGptTokenStatus, setChatGptTokenStatus] =
    useState<ChatGptTokenStatus>(DEFAULT_CHATGPT_TOKEN_STATUS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [activeWizard, setActiveWizard] = useState<Provider | null>(null);

  const mcpUrl = useMemo(() => {
    const base =
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
    return `${base.replace(/\/$/, "")}/mcp`;
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/integrations/status", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Failed to load integration status");
    }
    const data = await res.json();
    const integrations = data?.integrations ?? {};
    setStatusByProvider({
      claude: normalizeIntegrationStatus(integrations?.claude),
      chatgpt: normalizeIntegrationStatus(integrations?.chatgpt),
    });
  }, []);

  const loadChatGptTokenStatus = useCallback(async () => {
    const res = await fetch("/api/integrations/chatgpt/token", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Failed to load ChatGPT token status");
    }
    const data = await res.json();
    setChatGptTokenStatus(normalizeChatGptTokenStatus(data));
  }, []);

  const loadAll = useCallback(
    async (mode: "initial" | "refresh" = "refresh") => {
      if (mode === "initial") setLoading(true);
      if (mode === "refresh") setRefreshing(true);

      try {
        await Promise.all([loadStatus(), loadChatGptTokenStatus()]);
      } catch {
        setStatusByProvider(DEFAULT_STATUS_MAP);
        setChatGptTokenStatus({ ...DEFAULT_CHATGPT_TOKEN_STATUS, loading: false });
      } finally {
        if (mode === "initial") setLoading(false);
        if (mode === "refresh") setRefreshing(false);
      }
    },
    [loadChatGptTokenStatus, loadStatus]
  );

  useEffect(() => {
    void loadAll("initial");
  }, [loadAll]);

  const handleGenerateChatGptToken = useCallback(async (rotate?: boolean) => {
    setGeneratingToken(true);
    try {
      const res = await fetch("/api/integrations/chatgpt/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotate: Boolean(rotate) }),
      });

      if (!res.ok) {
        throw new Error("Failed to generate ChatGPT token");
      }

      const payload = await res.json();
      setChatGptTokenStatus((current) => ({
        ...current,
        ...normalizeChatGptTokenStatus(payload),
      }));
      await loadStatus();
    } catch {
      // Keep wizard open; the wizard itself surfaces verification status.
    } finally {
      setGeneratingToken(false);
    }
  }, [loadStatus]);

  const openWizard = useCallback((provider: Provider) => {
    setActiveWizard(provider);
  }, []);

  const closeWizard = useCallback(async () => {
    setActiveWizard(null);
    await loadAll("refresh");
  }, [loadAll]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>AI Assistants</h1>
          <p className={styles.pageSubtitle}>Connect AI clients and keep setup in sync.</p>
        </div>
        <div className={styles.headerRight}>
          <button
            className={styles.actionBtn}
            onClick={() => void loadAll("refresh")}
            disabled={loading || refreshing}
          >
            <RefreshCw size={16} className={refreshing ? styles.spin : ""} />
            Refresh
          </button>
        </div>
      </header>

      {loading ? (
        <div className={styles.grid}>
          {[1, 2, 3].map((idx) => (
            <div key={idx} className={styles.skeletonCard}>
              <div className={styles.skeletonHeadRow}>
                <div className={`${styles.skeleton} ${styles.skeletonLogo}`} />
                <div className={styles.skeletonHeadText}>
                  <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
                  <div className={`${styles.skeleton} ${styles.skeletonLineShort}`} />
                </div>
              </div>
              <div className={styles.skeletonMetaBlock}>
                <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
                <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              </div>
              <div className={styles.skeletonFooter}>
                <div className={`${styles.skeleton} ${styles.skeletonButton}`} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.grid}>
          {CONNECTORS.map((connector) => {
            const isComingSoon = Boolean(connector.comingSoon);
            const status =
              connector.id === "gemini" ? null : statusByProvider[connector.id as Provider];
            const meta = status ? stateMeta(status) : null;

            const actionLabel = isComingSoon
              ? "Coming soon"
              : status?.state === "connected"
                ? "Manage setup"
                : status?.state === "connecting" || status?.state === "checking"
                  ? "Continue setup"
                  : status?.state === "error"
                    ? "Repair setup"
                    : "Connect";

            return (
              <article key={connector.id} className={styles.connectorCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.logoWrap}>
                    <Image src={connector.icon} alt={connector.name} width={26} height={26} />
                  </div>
                  <div>
                    <h2 className={styles.cardTitle}>{connector.name}</h2>
                    <p className={styles.cardDescription}>{connector.description}</p>
                  </div>
                </div>

                <div className={styles.cardBody}>
                  {isComingSoon ? (
                    <div className={`${styles.statusPill} ${styles.statusSoon}`}>
                      <Sparkles size={13} />
                      Coming soon
                    </div>
                  ) : meta ? (
                    <>
                      <div className={`${styles.statusPill} ${meta.toneClass}`}>
                        {status?.state === "connected" ? (
                          <CheckCircle2 size={13} />
                        ) : status?.state === "error" ? (
                          <AlertCircle size={13} />
                        ) : (
                          <Clock3 size={13} />
                        )}
                        {meta.label}
                      </div>
                      <p className={styles.statusDetail}>{meta.detail}</p>
                    </>
                  ) : null}
                </div>

                <div className={styles.cardFooter}>
                  <Button
                    className={styles.primaryBtn}
                    disabled={isComingSoon}
                    onClick={() => {
                      if (connector.id === "claude") openWizard("claude");
                      if (connector.id === "chatgpt") openWizard("chatgpt");
                    }}
                  >
                    {actionLabel}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ClaudeWizard isOpen={activeWizard === "claude"} onClose={() => void closeWizard()} mcpUrl={mcpUrl} />
      <ChatGPTWizard
        isOpen={activeWizard === "chatgpt"}
        onClose={() => void closeWizard()}
        tokenStatus={chatGptTokenStatus}
        generatingToken={generatingToken}
        onGenerateToken={handleGenerateChatGptToken}
      />
    </div>
  );
}

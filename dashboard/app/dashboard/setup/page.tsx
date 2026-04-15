"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "../../../components/ui/button";
import { ClaudeWizard, ChatGPTWizard, Provider } from "./SetupWizards";

type IntegrationState = "checking" | "connecting" | "connected" | "error" | "not_connected";

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  canDisconnect: boolean;
  hasBearerToken?: boolean;
  lastTokenUsedAt?: string | null;
  lastTokenCreatedAt?: string | null;
};

type ChatGptTokenStatus = {
  loading: boolean;
  hasActiveToken: boolean;
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  lastTokenUsedAt: string | null;
};

type IntegrationStatusMap = {
  claude: IntegrationStatus;
  chatgpt: IntegrationStatus;
};

const DEFAULT_STATUS: IntegrationStatus = {
  state: "not_connected",
  connected: false,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  canDisconnect: false,
  hasBearerToken: false,
  lastTokenUsedAt: null,
  lastTokenCreatedAt: null,
};

const DEFAULT_CHATGPT_TOKEN_STATUS: ChatGptTokenStatus = {
  loading: true,
  hasActiveToken: false,
  activeTokenCount: 0,
  lastTokenCreatedAt: null,
  lastTokenUsedAt: null,
};

const DEFAULT_STATUS_MAP: IntegrationStatusMap = {
  claude: { ...DEFAULT_STATUS },
  chatgpt: { ...DEFAULT_STATUS },
};

function normalizeState(value: unknown): IntegrationState {
  if (value === "checking" || value === "connecting" || value === "connected" || value === "error" || value === "not_connected") {
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
    hasBearerToken: Boolean(value.hasBearerToken),
    lastTokenUsedAt: typeof value.lastTokenUsedAt === "string" ? value.lastTokenUsedAt : null,
    lastTokenCreatedAt: typeof value.lastTokenCreatedAt === "string" ? value.lastTokenCreatedAt : null,
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
    activeTokenCount: Number.isFinite(value.activeTokenCount as number) ? Number(value.activeTokenCount) : 0,
    lastTokenCreatedAt: typeof value.lastTokenCreatedAt === "string" ? value.lastTokenCreatedAt : null,
    lastTokenUsedAt: typeof value.lastTokenUsedAt === "string" ? value.lastTokenUsedAt : null,
  };
}

function statusUiState(state: IntegrationState, statusLoading: boolean): { label: string; border: string; color: string; background: string; } {
  if (statusLoading || state === "checking") {
    return { label: "Checking...", border: "1px solid rgba(148,163,184,.35)", color: "#94a3b8", background: "rgba(148,163,184,.08)" };
  }
  if (state === "connecting") {
    return { label: "Connecting...", border: "1px solid rgba(245,158,11,.35)", color: "#f59e0b", background: "rgba(245,158,11,.08)" };
  }
  if (state === "connected") {
    return { label: "Connected", border: "1px solid rgba(34,197,94,.35)", color: "#22c55e", background: "rgba(34,197,94,.08)" };
  }
  if (state === "error") {
    return { label: "Error", border: "1px solid rgba(239,68,68,.35)", color: "#ef4444", background: "rgba(239,68,68,.08)" };
  }
  return { label: "Not connected", border: "1px solid rgba(148,163,184,.35)", color: "#94a3b8", background: "rgba(148,163,184,.08)" };
}

/* ── Provider icons ────────────────────────────────────────── */
function ClaudeIcon() {
  return (
    <div style={{ backgroundColor: 'rgba(217, 119, 87, 0.1)', width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src="/claude.svg" alt="Claude" width={20} height={20} aria-hidden="true" />
    </div>
  );
}

function ChatGPTIcon() {
  return (
    <div style={{ backgroundColor: 'rgba(116, 170, 156, 0.1)', width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src="/chatgpt.svg" alt="ChatGPT" width={20} height={20} aria-hidden="true" />
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────── */
export default function ConnectorsPage() {
  const [selected, setSelected] = useState<Provider>("claude");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusByProvider, setStatusByProvider] = useState<IntegrationStatusMap>(DEFAULT_STATUS_MAP);
  const [chatgptTokenStatus, setChatgptTokenStatus] = useState<ChatGptTokenStatus>(DEFAULT_CHATGPT_TOKEN_STATUS);
  const [issuedChatgptToken, setIssuedChatgptToken] = useState<string | null>(null);
  const [generatingChatgptToken, setGeneratingChatgptToken] = useState(false);
  const [statusPollTick, setStatusPollTick] = useState(0);
  const [disconnectingProvider, setDisconnectingProvider] = useState<Provider | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mcpUrl = typeof window !== "undefined"
    ? `${window.location.origin}/mcp`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/mcp`;

  const openApiUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/chatgpt/openapi.json`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/chatgpt/openapi.json`;

  useEffect(() => {
    let isMounted = true;
    let inFlight = false;

    const loadStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [integrationRes, tokenRes] = await Promise.all([
          fetch("/api/integrations/status"),
          fetch("/api/integrations/chatgpt/token"),
        ]);

        if (integrationRes.ok) {
          const data = await integrationRes.json();
          const integrations = data?.integrations ?? {};
          const nextStatus: IntegrationStatusMap = {
            claude: normalizeIntegrationStatus(integrations?.claude),
            chatgpt: normalizeIntegrationStatus(integrations?.chatgpt),
          };
          if (isMounted) {
            setStatusByProvider(nextStatus);
          }
        }

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (isMounted) {
            setChatgptTokenStatus(normalizeChatGptTokenStatus(tokenData));
          }
        }
      } catch {
        // Best effort only.
      } finally {
        inFlight = false;
        if (isMounted) {
          setStatusLoading(false);
        }
      }
    };

    void loadStatus();
    const interval = window.setInterval(() => {
      void loadStatus();
    }, 4000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [statusPollTick]);

  const selectedStatus = statusByProvider[selected];
  const selectedProviderLabel = selected === "claude" ? "Claude" : "ChatGPT";

  async function refreshStatus() {
    setStatusLoading(true);
    setChatgptTokenStatus((prev) => ({ ...prev, loading: true }));
    setStatusPollTick((value) => value + 1);
  }

  async function rotateChatGptToken() {
    setGeneratingChatgptToken(true);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch("/api/integrations/chatgpt/token", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data?.error === "string" ? data.error : "Failed to generate ChatGPT bearer token.";
        throw new Error(message);
      }

      if (typeof data?.token === "string") {
        setIssuedChatgptToken(data.token);
      } else {
        setIssuedChatgptToken(null);
      }
      const message = typeof data?.message === "string"
        ? data.message
        : "ChatGPT bearer token created. Copy it now and paste it into GPT Actions.";
      setActionMessage(message);
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to generate ChatGPT bearer token.");
    } finally {
      setGeneratingChatgptToken(false);
    }
  }

  async function disconnectSelectedProvider() {
    const provider = selected;
    const label = provider === "claude" ? "Claude" : "ChatGPT";
    if (!window.confirm(`Disconnect ${label}? This revokes active connector credentials for this integration.`)) {
      return;
    }

    setDisconnectingProvider(provider);
    setActionMessage(null);
    setActionError(null);

    try {
      const res = await fetch("/api/integrations/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data?.error === "string" ? data.error : `Failed to disconnect ${label}.`;
        throw new Error(message);
      }

      const message = typeof data?.message === "string" ? data.message : `${label} disconnected.`;
      setActionMessage(message);
      if (provider === "chatgpt") {
        setIssuedChatgptToken(null);
      }
      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to disconnect ${label}.`;
      setActionError(message);
    } finally {
      setDisconnectingProvider(null);
    }
  }

  const providers: { id: Provider; name: string; sub: string; icon: React.FC; status: IntegrationStatus }[] = [
    {
      id: "claude",
      name: "Claude Desktop",
      sub: "Memory across every session",
      icon: ClaudeIcon,
      status: statusByProvider.claude,
    },
    {
      id: "chatgpt",
      name: "ChatGPT Projects",
      sub: "Import schema + Bearer token",
      icon: ChatGPTIcon,
      status: statusByProvider.chatgpt,
    },
  ];

  return (
    <div className="cnn-wrap" style={{maxWidth: '1000px', minHeight: 'calc(100vh - 80px)'}}>
      <div className="cnn-hero" style={{textAlign: 'left', paddingBottom: '2.5rem', paddingTop: '1rem'}}>
        <h1 className="cnn-title" style={{fontSize: '2rem'}}>Connect Tallei Memory</h1>
        <p style={{ fontSize: '0.9rem', color: '#6b7280', marginTop: '0.35rem' }}>Select a provider below to launch the automated setup wizard.</p>
      </div>

      <div className="cnn-provider-row-container" style={{
        display: 'grid',
        gridTemplateColumns: '1.3fr 1fr',
        gap: '2rem',
        marginBottom: '3rem',
        alignItems: 'start'
      }}>
        {providers.map((p, idx) => {
          const badge = statusUiState(p.status.state, statusLoading);
          const isFirst = idx === 0;
          return (
          <div
            key={p.id}
            className={`cnn-provider-card ${selected === p.id ? "active" : ""}`}
            onClick={() => setSelected(p.id)}
            style={{
              position: 'relative',
              padding: isFirst ? '2rem' : '1.75rem',
              transform: isFirst ? 'translateY(0)' : 'translateY(2rem)',
              transition: 'all 0.24s cubic-bezier(0.16, 1, 0.3, 1)',
              boxShadow: isFirst ? '0 8px 24px rgba(0,0,0,0.08)' : '0 4px 16px rgba(0,0,0,0.05)',
              border: `1px solid ${isFirst ? '#e5e7eb' : '#f3f4f6'}`,
              cursor: 'pointer',
              borderRadius: '16px',
              background: '#ffffff',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = isFirst ? '0 16px 48px rgba(0,0,0,0.12)' : '0 8px 32px rgba(0,0,0,0.08)';
              e.currentTarget.style.transform = isFirst ? 'translateY(-2px)' : 'translateY(calc(2rem - 2px))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = isFirst ? '0 8px 24px rgba(0,0,0,0.08)' : '0 4px 16px rgba(0,0,0,0.05)';
              e.currentTarget.style.transform = isFirst ? 'translateY(0)' : 'translateY(2rem)';
            }}
          >
            <div className="cnn-provider-icon-title-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minHeight: isFirst ? '320px' : '280px' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                 <div className="cnn-provider-icon" style={{border: 'none', background: 'transparent', width: '52px', height: '52px', flexShrink: 0}}>
                   <p.icon />
                 </div>
                 <div style={{
                   fontSize: "0.75rem",
                   fontWeight: 600,
                   padding: "0.35rem 0.85rem",
                   borderRadius: "999px",
                   border: badge.border,
                   color: badge.color,
                   background: badge.background,
                   whiteSpace: 'nowrap'
                 }}>
                   {badge.label}
                 </div>
               </div>
              <div className="cnn-provider-text" style={{ flex: 1 }}>
                <div className="cnn-provider-name" style={{ fontSize: isFirst ? '1.35rem' : '1.2rem', marginBottom: '0.35rem', fontWeight: 600 }}>{p.name}</div>
                <div className="cnn-provider-sub" style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>{p.sub}</div>
              </div>
              <div style={{ marginTop: 'auto', paddingTop: isFirst ? '2rem' : '1.5rem' }}>
                <Button variant={selected === p.id ? "default" : "outline"} style={{ width: '100%', borderRadius: '8px' }} onClick={() => setWizardOpen(true)}>
                  {p.status.state === "connected" ? "Manage Configuration" : "Start Setup"}
                </Button>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {actionMessage && (
        <div style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#22c55e", padding: '1rem', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#ef4444", padding: '1rem', background: '#fef2f2', borderRadius: '8px', border: '1px solid #fecaca' }}>
          {actionError}
        </div>
      )}

      {selected === "claude" && (
        <ClaudeWizard 
          isOpen={wizardOpen && selected === "claude"} 
          onClose={() => setWizardOpen(false)} 
          mcpUrl={mcpUrl} 
        />
      )}
      
      {selected === "chatgpt" && (
        <ChatGPTWizard 
          isOpen={wizardOpen && selected === "chatgpt"} 
          onClose={() => setWizardOpen(false)}
          tokenStatus={chatgptTokenStatus}
          issuedToken={issuedChatgptToken}
          generatingToken={generatingChatgptToken}
          onGenerateToken={rotateChatGptToken}
          openApiUrl={openApiUrl}
        />
      )}

      {/* Debug/Management controls below */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '1.5rem', marginTop: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem', opacity: 0.7 }}>
        <div style={{ fontSize: "0.8rem", color: selectedStatus.state === "error" ? "#ef4444" : "#6b7280" }}>
          {selectedStatus.state === "error" && selectedStatus.lastError
            ? selectedStatus.lastError
            : "Troubleshooting & Management"}
        </div>
        <div style={{ display: "flex", gap: "0.55rem" }}>
          <Button variant="outline" size="sm" onClick={() => void refreshStatus()} disabled={statusLoading || disconnectingProvider !== null}>
            Refresh status
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void disconnectSelectedProvider()}
            disabled={statusLoading || disconnectingProvider !== null || !selectedStatus.canDisconnect}
          >
            {disconnectingProvider === selected ? "Disconnecting..." : `Disconnect ${selectedProviderLabel}`}
          </Button>
        </div>
      </div>

    </div>
  );
}

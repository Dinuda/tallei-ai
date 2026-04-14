"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "../../../components/ui/button";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";
const CHATGPT_BUILDER_URL = "https://chatgpt.com/gpts/editor";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory tools.

Rules:
1) On the first user message in each new chat, call recallMemories with a broad query before replying.
2) Before answering personal/contextual questions, call recallMemories first.
3) When the user shares a durable fact or preference, call saveMemory in the same turn.
4) If the user corrects a prior fact, call saveMemory with the corrected fact.
5) Do not mention tool calls in the final user-facing response.`;

type Provider = "claude" | "chatgpt";
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

function statusUiState(state: IntegrationState, statusLoading: boolean): {
  label: string;
  border: string;
  color: string;
  background: string;
} {
  if (statusLoading || state === "checking") {
    return {
      label: "Checking...",
      border: "1px solid rgba(148,163,184,.35)",
      color: "#94a3b8",
      background: "rgba(148,163,184,.08)",
    };
  }

  if (state === "connecting") {
    return {
      label: "Connecting...",
      border: "1px solid rgba(245,158,11,.35)",
      color: "#f59e0b",
      background: "rgba(245,158,11,.08)",
    };
  }

  if (state === "connected") {
    return {
      label: "Connected",
      border: "1px solid rgba(34,197,94,.35)",
      color: "#22c55e",
      background: "rgba(34,197,94,.08)",
    };
  }

  if (state === "error") {
    return {
      label: "Error",
      border: "1px solid rgba(239,68,68,.35)",
      color: "#ef4444",
      background: "rgba(239,68,68,.08)",
    };
  }

  return {
    label: "Not connected",
    border: "1px solid rgba(148,163,184,.35)",
    color: "#94a3b8",
    background: "rgba(148,163,184,.08)",
  };
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString();
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

/* ── Code block ────────────────────────────────────────────── */
function CodeBlock({ value, language = "txt", onCopy }: { value: string; language?: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {/* ignore */}
  };

  const getLanguageIcon = (lang: string) => {
    if (lang === 'python') return '🐍';
    if (lang === 'url') return '🔗';
    if (lang === 'json') return 'JSON';
    return null;
  };

  return (
    <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden' }}>
      <div className="cnn-code-header" style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', color: '#4b5563', fontWeight: 500 }}>
        <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
          {getLanguageIcon(language) && <span style={{ fontSize: '1rem' }}>{getLanguageIcon(language)}</span>}
          <span style={{ textTransform: 'lowercase' }}>{language}</span>
        </div>
        <button
          type="button"
          className={`cnn-copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy"}
          aria-label="Copy to clipboard"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: copied ? '#10b981' : '#6b7280', transition: 'all 0.2s' }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <div className="cnn-code-content" style={{ padding: '1rem', overflowX: 'auto' }}>
        <code className="cnn-code-text" style={{ whiteSpace: 'pre-wrap', display: 'block', fontSize: '0.875rem', fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace', color: '#1f2937' }}>{value}</code>
      </div>
    </div>
  );
}

/* ── Claude setup ──────────────────────────────────────────── */
function ClaudeSetup() {
  const mcpUrl = typeof window !== "undefined"
    ? `${window.location.origin}/mcp`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/mcp`;

  return (
    <div className="su-root animate-fade-in">
      <div className="su-steps-grid">
        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">1</div>
            <div className="su-step-text">
              <div className="su-step-title">Copy Configuration</div>
              <p className="su-step-body">Copy the Name and URL below to use in your Claude config.</p>
            </div>
          </div>
          <div className="su-step-right">
            <div style={{ marginBottom: "0.5rem" }}><strong style={{ fontSize: "0.85rem", color: "var(--text)" }}>Name</strong></div>
            <CodeBlock value="Tallei Memory" language="txt" />
            <div style={{ marginTop: "1rem", marginBottom: "0.5rem" }}><strong style={{ fontSize: "0.85rem", color: "var(--text)" }}>Remote MCP server URL</strong></div>
            <CodeBlock value={mcpUrl} language="url" />
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">2</div>
            <div className="su-step-text">
              <div className="su-step-title">Open Connectors</div>
              <p className="su-step-body">Open Claude connector settings in your browser.</p>
            </div>
          </div>
          <div className="su-step-right" style={{ display: 'flex', alignItems: 'flex-start', paddingTop: '0.15rem' }}>
             <Button variant="outline" onClick={() => window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener,noreferrer")} style={{ background: '#ffffff', border: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', color: '#1f2937' }}>
               Open Claude Connectors <ExternalLink size={14} className="ml-2" style={{ marginLeft: "6px" }} />
             </Button>
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">3</div>
            <div className="su-step-text">
              <div className="su-step-title">Add Connector</div>
              <p className="su-step-body">In Claude, click <strong>Add custom connector</strong>, paste the Name and URL, and keep Advanced settings empty.</p>
            </div>
          </div>
          <div className="su-step-right">
             <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '1rem', color: '#4b5563', fontSize: '0.85rem' }}>
               Navigate to Claude's Settings &gt; Connectors &gt; Add custom connector.
             </div>
          </div>
        </div>

        <div className="su-step-row su-step-row-last">
          <div className="su-step-left">
            <div className="su-step-num">4</div>
            <div className="su-step-text">
              <div className="su-step-title">Authorize</div>
              <p className="su-step-body">Click <strong>Connect</strong> and approve OAuth access to finish setup.</p>
            </div>
          </div>
          <div className="su-step-right">
             <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '1rem', color: '#4b5563', fontSize: '0.85rem' }}>
               Approve the connection and start using Tallei in Claude!
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ChatGPT setup ─────────────────────────────────────────── */
function ChatGptSetup(props: {
  tokenStatus: ChatGptTokenStatus;
  issuedToken: string | null;
  generatingToken: boolean;
  onGenerateToken: () => Promise<void>;
}) {
  const { tokenStatus, issuedToken, generatingToken, onGenerateToken } = props;
  const [copiedInstructions, setCopiedInstructions] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  const openApiUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/chatgpt/openapi.json`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/chatgpt/openapi.json`;

  const copyInstructions = async () => {
    await navigator.clipboard.writeText(CHATGPT_INSTRUCTIONS_TEMPLATE).catch(() => {});
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 2000);
  };

  const copyToken = async () => {
    if (!issuedToken) return;
    await navigator.clipboard.writeText(issuedToken).catch(() => {});
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  return (
    <div className="su-root animate-fade-in">
      <div className="su-steps-grid">
        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">1</div>
            <div className="su-step-text">
              <div className="su-step-title">Create Bearer Token</div>
              <p className="su-step-body">Generate a ChatGPT Actions bearer token on this page. This token is shown only once after generation.</p>
            </div>
          </div>
          <div className="su-step-right">
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: "0.8rem" }}>
              <Button
                variant="default"
                onClick={() => void onGenerateToken()}
                disabled={generatingToken}
              >
                {generatingToken ? "Generating..." : tokenStatus.hasActiveToken ? "Rotate Token" : "Generate Token"}
              </Button>
              <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                Active tokens: {tokenStatus.activeTokenCount}
              </span>
            </div>
            {issuedToken ? (
              <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden' }}>
                <div className="cnn-code-header" style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', color: '#4b5563', fontWeight: 500 }}>
                  <span>chatgpt_bearer_token</span>
                  <button
                    type="button"
                    className={`cnn-copy-btn ${copiedToken ? "copied" : ""}`}
                    onClick={copyToken}
                    title={copiedToken ? "Copied!" : "Copy"}
                    aria-label="Copy token"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: copiedToken ? '#10b981' : '#6b7280', transition: 'all 0.2s' }}
                  >
                    {copiedToken ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <div className="cnn-code-content" style={{ padding: '1rem', overflowX: 'auto' }}>
                  <code className="cnn-code-text" style={{ whiteSpace: 'pre-wrap', display: 'block', fontSize: '0.875rem', fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace', color: '#1f2937' }}>{issuedToken}</code>
                </div>
              </div>
            ) : (
              <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '1rem', color: '#4b5563', fontSize: '0.85rem' }}>
                Last created: {formatDateTime(tokenStatus.lastTokenCreatedAt)}<br />
                Last used: {formatDateTime(tokenStatus.lastTokenUsedAt)}
              </div>
            )}
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">2</div>
            <div className="su-step-text">
              <div className="su-step-title">Import OpenAPI URL</div>
              <p className="su-step-body">In GPT Builder → Actions, click <strong>Import from URL</strong> and paste this schema URL.</p>
            </div>
          </div>
          <div className="su-step-right">
            <CodeBlock value={openApiUrl} language="url" />
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">3</div>
            <div className="su-step-text">
              <div className="su-step-title">Set Action Auth</div>
              <p className="su-step-body">Use API key bearer auth in the Actions auth modal.</p>
            </div>
          </div>
          <div className="su-step-right">
            <ol className="cnn-list" style={{marginBottom: '1rem'}}>
              <li>Authentication Type: <strong>API Key</strong></li>
              <li>Auth Type: <strong>Bearer</strong></li>
              <li>API Key: paste the token from Step 1</li>
              <li>Save, then keep this action attached to your GPT</li>
            </ol>
            <Button
              variant="outline"
              onClick={() => window.open(CHATGPT_BUILDER_URL, "_blank", "noopener,noreferrer")}
              style={{ alignSelf: 'flex-start' }}
            >
              Open GPT Builder <ExternalLink size={14} style={{ marginLeft: "6px" }} />
            </Button>
          </div>
        </div>

        <div className="su-step-row su-step-row-last">
          <div className="su-step-left">
            <div className="su-step-num">4</div>
            <div className="su-step-text">
              <div className="su-step-title">Publish & Test</div>
              <p className="su-step-body">Paste these instructions into your GPT, publish, then test memory recall in Preview.</p>
            </div>
          </div>
          <div className="su-step-right">
            <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', marginBottom: '0.5rem', overflow: 'hidden' }}>
               <div className="cnn-code-header" style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', color: '#4b5563', fontWeight: 500 }}>
                 <span>instructions</span>
                 <button
                    type="button"
                    className={`cnn-copy-btn ${copiedInstructions ? "copied" : ""}`}
                    onClick={copyInstructions}
                    title={copiedInstructions ? "Copied!" : "Copy"}
                    aria-label="Copy to clipboard"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: copiedInstructions ? '#10b981' : '#6b7280', transition: 'all 0.2s' }}
                  >
                    {copiedInstructions ? <Check size={16} /> : <Copy size={16} />}
                  </button>
               </div>
               <div className="cnn-code-content" style={{ padding: '1rem', overflowX: 'auto' }}>
                 <code className="cnn-code-text" style={{ whiteSpace: 'pre-wrap', display: 'block', fontSize: '0.875rem', fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace', color: '#1f2937' }}>{CHATGPT_INSTRUCTIONS_TEMPLATE}</code>
               </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────── */
export default function ConnectorsPage() {
  const [selected, setSelected] = useState<Provider>("claude");
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusByProvider, setStatusByProvider] = useState<IntegrationStatusMap>(DEFAULT_STATUS_MAP);
  const [chatgptTokenStatus, setChatgptTokenStatus] = useState<ChatGptTokenStatus>(DEFAULT_CHATGPT_TOKEN_STATUS);
  const [issuedChatgptToken, setIssuedChatgptToken] = useState<string | null>(null);
  const [generatingChatgptToken, setGeneratingChatgptToken] = useState(false);
  const [statusPollTick, setStatusPollTick] = useState(0);
  const [disconnectingProvider, setDisconnectingProvider] = useState<Provider | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      name: "Claude MCP",
      sub: "Memory across every session",
      icon: ClaudeIcon,
      status: statusByProvider.claude,
    },
    {
      id: "chatgpt",
      name: "ChatGPT Action",
      sub: "Import URL + Bearer token",
      icon: ChatGPTIcon,
      status: statusByProvider.chatgpt,
    },
  ];

  return (
    <div className="cnn-wrap" style={{maxWidth: '1000px'}}>
      <div className="cnn-hero" style={{textAlign: 'left', paddingBottom: '1.5rem', paddingTop: '1rem'}}>
        <h1 className="cnn-title" style={{fontSize: '2rem'}}>Connect Tallei Memory</h1>
      </div>

      <div className="cnn-provider-row-container" style={{justifyContent: 'flex-start', marginBottom: '2rem'}}>
        {providers.map((p) => {
          const badge = statusUiState(p.status.state, statusLoading);
          return (
          <div
            key={p.id}
            className={`cnn-provider-card ${selected === p.id ? "active" : ""}`}
            onClick={() => setSelected(p.id)}
          >
            <div className="cnn-provider-icon-title-wrap">
               <div className="cnn-provider-icon" style={{border: 'none', background: 'transparent', width: '28px', height: '28px'}}>
                 <p.icon />
               </div>
              <div className="cnn-provider-text">
                <div className="cnn-provider-name">{p.name}</div>
                <div className="cnn-provider-sub">{p.sub}</div>
                <div
                  style={{
                    marginTop: "0.4rem",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    padding: "0.18rem 0.55rem",
                    borderRadius: "999px",
                    border: badge.border,
                    color: badge.color,
                    background: badge.background,
                  }}
                >
                  {badge.label}
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.8rem", marginBottom: "1.2rem" }}>
        <div style={{ fontSize: "0.85rem", color: selectedStatus.state === "error" ? "#ef4444" : "#6b7280" }}>
          {selectedStatus.state === "error" && selectedStatus.lastError
            ? selectedStatus.lastError
            : "Connection state is scoped to your account only."}
        </div>
        <div style={{ display: "flex", gap: "0.55rem" }}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshStatus()}
            disabled={statusLoading || disconnectingProvider !== null}
          >
            Refresh status
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void disconnectSelectedProvider()}
            disabled={
              statusLoading ||
              disconnectingProvider !== null ||
              !selectedStatus.canDisconnect
            }
          >
            {disconnectingProvider === selected
              ? "Disconnecting..."
              : `Disconnect ${selectedProviderLabel}`}
          </Button>
        </div>
      </div>

      {actionMessage && (
        <div style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#22c55e" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#ef4444" }}>
          {actionError}
        </div>
      )}

      {selected === "claude" && <ClaudeSetup />}
      {selected === "chatgpt" && (
        <ChatGptSetup
          tokenStatus={chatgptTokenStatus}
          issuedToken={issuedChatgptToken}
          generatingToken={generatingChatgptToken}
          onGenerateToken={rotateChatGptToken}
        />
      )}
    </div>
  );
}

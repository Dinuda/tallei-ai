"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Copy, ExternalLink, Terminal } from "lucide-react";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";
const CHATGPT_BUILDER_URL = "https://chatgpt.com/gpts/editor";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory tools.

Rules:
1) On the first user message in each new chat, call recallMemories with a broad query before replying.
2) Before answering personal/contextual questions, call recallMemories first.
3) When the user shares a durable fact or preference, call saveMemory in the same turn.
4) If the user corrects a prior fact, call saveMemory with the corrected fact.
5) Do not mention tool calls in the final user-facing response.`;

const CHATGPT_BUILDER_BOOTSTRAP_PROMPT = `Create a GPT named "Tallei Memory Assistant" that uses external Actions to persist and recall user memory. Keep responses concise and practical.`;

type Provider = "claude" | "chatgpt";
type StepStatus = "done" | "active" | "upcoming";

/* ── Connector status card ─────────────────────────────────────── */
function ConnectorCard({
  provider,
  connected,
  loading,
  expanded,
  onToggle,
}: {
  provider: Provider;
  connected: boolean;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isClaude = provider === "claude";

  const accent = isClaude
    ? { color: "#ffc97a", border: "rgba(251,146,60,.24)", bg: "rgba(251,146,60,.08)" }
    : { color: "#a8d4ff", border: "rgba(96,165,250,.24)",  bg: "rgba(96,165,250,.08)" };

  const icon = isClaude ? (
    <svg width="20" height="20" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="20" fill={accent.bg} />
      <path d="M20 10C14.5 10 10 14.5 10 20s4.5 10 10 10 10-4.5 10-10-4.5-10-10-10Z" stroke={accent.color} strokeWidth="1.8" />
      <path d="M15 18h10M15 22h7" stroke={accent.color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="20" fill={accent.bg} />
      <path d="M12 20h16M20 12v16" stroke={accent.color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );

  return (
    <div
      style={{
        border: expanded ? `1px solid ${accent.border}` : "1px solid #1f2530",
        borderRadius: "14px",
        background: expanded ? "rgba(255,255,255,.02)" : "#0d1117",
        overflow: "hidden",
        transition: "border-color 0.18s, background 0.18s",
      }}
    >
      {/* Card header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%", display: "flex", alignItems: "center",
          gap: "1rem", padding: "1.1rem 1.25rem",
          background: "none", border: "none", cursor: "pointer",
          textAlign: "left",
        }}
      >
        {icon}

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "0.92rem", fontWeight: 600, color: "#fafafa", marginBottom: "0.18rem" }}>
            {isClaude ? "Claude" : "ChatGPT"}
          </p>
          <p style={{ fontSize: "0.78rem", color: "#52525b" }}>
            {isClaude ? "MCP connector" : "Custom GPT Actions"}
          </p>
        </div>

        {/* Status badge */}
        {loading ? (
          <span style={{ fontSize: "0.72rem", color: "#3f4654" }}>Checking…</span>
        ) : connected ? (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "0.3rem",
            padding: "0.2rem 0.65rem", borderRadius: "999px",
            fontSize: "0.72rem", fontWeight: 600,
            background: "rgba(58,159,86,.14)", border: "1px solid rgba(58,159,86,.3)",
            color: "#7ae89b",
          }}>
            <span style={{
              width: "5px", height: "5px", borderRadius: "50%",
              background: "#4ade80", flexShrink: 0,
            }} />
            Connected
          </span>
        ) : (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "0.3rem",
            padding: "0.2rem 0.65rem", borderRadius: "999px",
            fontSize: "0.72rem", fontWeight: 500,
            background: "#141920", border: "1px solid #2a3039",
            color: "#52525b",
          }}>
            Not set up
          </span>
        )}

        {/* Chevron */}
        <svg
          width="14" height="14" viewBox="0 0 15 15" fill="none"
          style={{ color: "#3f4654", flexShrink: 0, transition: "transform 0.18s", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
          aria-hidden
        >
          <path d="M3 5.5l4.5 4 4.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Expanded setup wizard */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${accent.border}` }}>
          {isClaude ? (
            <ClaudeWizard />
          ) : (
            <ChatGptWizard />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Shared step component ─────────────────────────────────────── */
function Step({
  number,
  totalSteps,
  status,
  title,
  onActivate,
  children,
}: {
  number: number;
  totalSteps: number;
  status: StepStatus;
  title: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const isActive = status === "active";
  const isDone = status === "done";
  const isUpcoming = status === "upcoming";

  return (
    <div className={`su-step${isActive ? " active" : ""}${isDone ? " done" : ""}${isUpcoming ? " upcoming" : ""}`}>
      <div className="su-step-aside">
        <button
          type="button"
          className="su-step-num"
          onClick={isUpcoming ? undefined : onActivate}
          disabled={isUpcoming}
          aria-label={`Step ${number}`}
        >
          {isDone ? <Check size={13} /> : number}
        </button>
        {number < totalSteps && <div className="su-step-line" />}
      </div>
      <div className="su-step-main">
        <button
          type="button"
          className="su-step-title"
          onClick={isUpcoming ? undefined : onActivate}
          disabled={isUpcoming}
        >
          {title}
        </button>
        {isActive && <div className="su-step-content">{children}</div>}
      </div>
    </div>
  );
}

/* ── Claude wizard ─────────────────────────────────────────────── */
function ClaudeWizard() {
  const [activeStep, setActiveStep] = useState(1);
  const [copied, setCopied] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const connectorUrl = typeof window !== "undefined"
    ? `${window.location.origin}/mcp`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/mcp`;

  const ss = (id: number): StepStatus =>
    id < activeStep ? "done" : id === activeStep ? "active" : "upcoming";

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setCopyWarning("Clipboard blocked — copy the URL below manually.");
      return false;
    }
  };

  const onCopy = async () => {
    const ok = await copyUrl();
    if (ok) setActiveStep((p) => Math.max(p, 2));
  };

  const onOpenClaude = async () => {
    await copyUrl();
    window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener,noreferrer");
    setActiveStep((p) => Math.max(p, 3));
  };

  return (
    <div style={{ padding: "1.25rem 1.25rem 1rem" }}>
      {/* URL card */}
      <div className="su-url-card" style={{ marginBottom: "1.25rem" }}>
        <div className="su-url-label">
          <Terminal size={12} />
          MCP endpoint
        </div>
        <div className="su-url-row">
          <code className="su-url-text">{connectorUrl}</code>
          <button
            type="button"
            className={`su-copy-btn${copied ? " copied" : ""}`}
            onClick={onCopy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {copyWarning && <p className="su-url-warning">{copyWarning}</p>}
      </div>

      <div className="su-steps">
        <Step number={1} totalSteps={4} status={ss(1)} title="Copy MCP URL" onActivate={() => setActiveStep(1)}>
          <p className="su-step-body">Copy your unique MCP endpoint — you'll paste it into Claude settings.</p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onCopy}>
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy URL</>}
            </button>
            <button type="button" className="su-btn-ghost" onClick={() => setActiveStep((p) => Math.max(p, 2))}>
              Skip <ArrowRight size={13} />
            </button>
          </div>
        </Step>

        <Step number={2} totalSteps={4} status={ss(2)} title="Open Claude Settings" onActivate={() => setActiveStep(2)}>
          <p className="su-step-body">Opens claude.ai/settings/connectors and copies the URL automatically.</p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onOpenClaude}>
              Open Claude + Copy URL <ExternalLink size={13} />
            </button>
          </div>
        </Step>

        <Step number={3} totalSteps={4} status={ss(3)} title="Add Custom Connector" onActivate={() => setActiveStep(3)}>
          <ol className="su-checklist">
            <li>Click <strong>Add custom connector</strong></li>
            <li>Paste your MCP URL and save</li>
          </ol>
          <button type="button" className="su-btn-primary" onClick={() => setActiveStep((p) => Math.max(p, 4))}>
            Done <Check size={13} />
          </button>
        </Step>

        <Step number={4} totalSteps={4} status={ss(4)} title="Authorize and Connect" onActivate={() => setActiveStep(4)}>
          <ol className="su-checklist">
            <li>Find <strong>Tallei</strong> in connectors and click <strong>Connect</strong></li>
            <li>Approve the access request</li>
          </ol>
          <div className="su-step-actions">
            <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer" className="su-btn-ghost">
              Go to Claude <ExternalLink size={13} />
            </a>
            <button type="button" className="su-btn-primary" onClick={() => setIsComplete(true)}>
              Finish <Check size={13} />
            </button>
          </div>
        </Step>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up" style={{ marginTop: "1rem" }}>
          <div className="su-success-icon"><Check size={18} /></div>
          <div>
            <p className="su-success-title">Claude is connected</p>
            <p className="su-success-desc">Memory syncing is active.</p>
          </div>
          <Link href="/dashboard" className="su-btn-ghost su-success-link">
            View memories <ArrowRight size={13} />
          </Link>
        </div>
      )}

      <p className="su-footnote" style={{ marginTop: "1rem" }}>
        Using Claude Desktop? Configure via <code>claude_desktop_config.json</code>. Claude.ai connectors require a public HTTPS URL.
      </p>
    </div>
  );
}

/* ── ChatGPT wizard ────────────────────────────────────────────── */
function ChatGptWizard() {
  const [activeStep, setActiveStep] = useState(1);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedOpenApi, setCopiedOpenApi] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [alreadyConnected, setAlreadyConnected] = useState(false);

  const openApiUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/chatgpt/openapi.json`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/chatgpt/openapi.json`;

  const ss = (id: number): StepStatus =>
    id < activeStep ? "done" : id === activeStep ? "active" : "upcoming";

  const copyValue = async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      setCopyWarning("Clipboard blocked — copy manually from the field below.");
      return false;
    }
  };

  const generateApiKey = async () => {
    setGeneratingKey(true);
    setCopyWarning(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ChatGPT Actions", connectorType: "chatgpt" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setAlreadyConnected(true);
        return;
      }
      if (!res.ok || typeof data?.key !== "string") {
        throw new Error(data?.error || "Failed to generate API key");
      }
      setAlreadyConnected(false);
      setGeneratedKey(data.key);
      setActiveStep((p) => Math.max(p, 2));
    } catch (error) {
      setCopyWarning(error instanceof Error ? error.message : "Failed to generate API key");
    } finally {
      setGeneratingKey(false);
    }
  };

  const onCopyKey = async () => {
    if (!generatedKey) return;
    const ok = await copyValue(generatedKey);
    if (!ok) return;
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const onCopyOpenApi = async () => {
    const ok = await copyValue(openApiUrl);
    if (!ok) return;
    setCopiedOpenApi(true);
    setTimeout(() => setCopiedOpenApi(false), 2000);
    setActiveStep((p) => Math.max(p, 3));
  };

  return (
    <div style={{ padding: "1.25rem 1.25rem 1rem" }}>
      {/* OpenAPI URL card */}
      <div className="su-url-card" style={{ marginBottom: "1.25rem" }}>
        <div className="su-url-label">
          <Terminal size={12} />
          OpenAPI schema URL
        </div>
        <div className="su-url-row">
          <code className="su-url-text">{openApiUrl}</code>
          <button
            type="button"
            className={`su-copy-btn${copiedOpenApi ? " copied" : ""}`}
            onClick={onCopyOpenApi}
          >
            {copiedOpenApi ? <Check size={14} /> : <Copy size={14} />}
            {copiedOpenApi ? "Copied" : "Copy"}
          </button>
        </div>
        {copyWarning && <p className="su-url-warning">{copyWarning}</p>}
      </div>

      <div className="su-steps">
        <Step number={1} totalSteps={5} status={ss(1)} title="Generate API Key" onActivate={() => setActiveStep(1)}>
          <p className="su-step-body">Create a dedicated key scoped to ChatGPT. Shown only once.</p>
          {alreadyConnected && (
            <div className="su-inline-secret" style={{ borderColor: "#8ec642", marginBottom: "0.75rem" }}>
              <p className="su-inline-secret-note">
                You already have an active ChatGPT key.{" "}
                <Link href="/dashboard/keys" style={{ color: "#8ec642", textDecoration: "underline" }}>Revoke it</Link>{" "}
                to generate a new one.
              </p>
            </div>
          )}
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" disabled={generatingKey} onClick={generateApiKey}>
              {generatingKey ? "Generating…" : "Generate key"}
            </button>
            {generatedKey && (
              <button type="button" className="su-btn-ghost" onClick={onCopyKey}>
                {copiedKey ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy key</>}
              </button>
            )}
            <button type="button" className="su-btn-ghost" onClick={() => setActiveStep((p) => Math.max(p, 2))}>
              Continue <ArrowRight size={13} />
            </button>
          </div>
          {generatedKey && (
            <div className="su-inline-secret">
              <p className="su-inline-secret-note">Save this key — it won't be shown again.</p>
              <div className="su-url-row">
                <code className="su-url-text">{generatedKey}</code>
              </div>
            </div>
          )}
        </Step>

        <Step number={2} totalSteps={5} status={ss(2)} title="Copy OpenAPI URL" onActivate={() => setActiveStep(2)}>
          <p className="su-step-body">Paste this into GPT Builder → Actions → Import from URL.</p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onCopyOpenApi}>
              {copiedOpenApi ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy URL</>}
            </button>
            <button type="button" className="su-btn-ghost" onClick={() => setActiveStep((p) => Math.max(p, 3))}>
              Continue <ArrowRight size={13} />
            </button>
          </div>
        </Step>

        <Step number={3} totalSteps={5} status={ss(3)} title="Open GPT Builder" onActivate={() => setActiveStep(3)}>
          <p className="su-step-body">
            Opens GPT Builder. Switch to the <strong>Configure</strong> tab before adding Actions.
          </p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={() => {
              window.open(CHATGPT_BUILDER_URL, "_blank", "noopener,noreferrer");
              setActiveStep((p) => Math.max(p, 4));
            }}>
              Open GPT Builder <ExternalLink size={13} />
            </button>
          </div>
        </Step>

        <Step number={4} totalSteps={5} status={ss(4)} title="Add Action + Set Auth" onActivate={() => setActiveStep(4)}>
          <ol className="su-checklist">
            <li>In <strong>Configure</strong>, scroll to <strong>Actions</strong> → <strong>Create new action</strong></li>
            <li>Import from URL (paste your OpenAPI URL)</li>
            <li>Set auth: <strong>API Key</strong>, header <code>Authorization</code>, value <code>Bearer gm_…</code></li>
            <li>Save the action</li>
          </ol>
          <button type="button" className="su-btn-primary" onClick={() => setActiveStep((p) => Math.max(p, 5))}>
            Done <Check size={13} />
          </button>
        </Step>

        <Step number={5} totalSteps={5} status={ss(5)} title="Add Instructions + Publish" onActivate={() => setActiveStep(5)}>
          <p className="su-step-body">
            Paste these into the <strong>Instructions</strong> field, then publish the GPT.
          </p>
          <textarea
            className="su-instruction-box"
            readOnly
            value={CHATGPT_INSTRUCTIONS_TEMPLATE}
            aria-label="ChatGPT memory instructions"
          />
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={async () => {
              const ok = await copyValue(CHATGPT_INSTRUCTIONS_TEMPLATE);
              if (ok) { setCopiedInstructions(true); setTimeout(() => setCopiedInstructions(false), 2000); }
            }}>
              {copiedInstructions ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy instructions</>}
            </button>
            <button type="button" className="su-btn-ghost" onClick={() => setIsComplete(true)}>
              Finish <Check size={13} />
            </button>
          </div>
        </Step>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up" style={{ marginTop: "1rem" }}>
          <div className="su-success-icon"><Check size={18} /></div>
          <div>
            <p className="su-success-title">ChatGPT is connected</p>
            <p className="su-success-desc">Memory syncing is active via Actions API.</p>
          </div>
          <Link href="/dashboard" className="su-btn-ghost su-success-link">
            View memories <ArrowRight size={13} />
          </Link>
        </div>
      )}
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function ConnectorsPage() {
  const [expanded, setExpanded] = useState<Provider | null>(null);
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [chatgptConnected, setChatgptConnected] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const [memoriesRes, keysRes] = await Promise.all([
          fetch("/api/memories"),
          fetch("/api/keys"),
        ]);

        if (memoriesRes.ok) {
          const data = await memoriesRes.json();
          const memories: Array<{ metadata?: { platform?: string } }> = data.memories || [];
          setClaudeConnected(memories.some((m) => m.metadata?.platform === "claude"));
        }

        if (keysRes.ok) {
          const data = await keysRes.json();
          const keys: Array<{ connectorType: string | null; revokedAt: string | null }> = data.keys || [];
          setChatgptConnected(keys.some((k) => k.connectorType === "chatgpt" && !k.revokedAt));
        }
      } catch {
        // non-blocking
      } finally {
        setStatusLoading(false);
      }
    };

    checkStatus();
  }, []);

  const toggle = (provider: Provider) => {
    setExpanded((cur) => (cur === provider ? null : provider));
  };

  return (
    <div className="page-stack" style={{ gap: "0" }}>
      {/* ── Header ── */}
      <header style={{ marginBottom: "1.75rem" }}>
        <h2 className="page-title" style={{ marginBottom: "0.25rem" }}>Connectors</h2>
        <p className="page-subtitle" style={{ fontSize: "0.84rem" }}>
          Link your AI assistants to share one private memory graph
        </p>
      </header>

      {/* ── Status cards ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
        <ConnectorCard
          provider="claude"
          connected={claudeConnected}
          loading={statusLoading}
          expanded={expanded === "claude"}
          onToggle={() => toggle("claude")}
        />
        <ConnectorCard
          provider="chatgpt"
          connected={chatgptConnected}
          loading={statusLoading}
          expanded={expanded === "chatgpt"}
          onToggle={() => toggle("chatgpt")}
        />
      </div>

      {/* ── Footer note ── */}
      <p style={{ fontSize: "0.78rem", color: "#3f4654", marginTop: "1.5rem", lineHeight: 1.6 }}>
        Both connectors share the same memory graph — what Claude saves, ChatGPT can recall, and vice versa.
      </p>
    </div>
  );
}

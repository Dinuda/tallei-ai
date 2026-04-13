"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";
const CHATGPT_BUILDER_URL = "https://chatgpt.com/gpts/editor";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory tools.

Rules:
1) On the first user message in each new chat, call recallMemories with a broad query before replying.
2) Before answering personal/contextual questions, call recallMemories first.
3) When the user shares a durable fact or preference, call saveMemory in the same turn.
4) If the user corrects a prior fact, call saveMemory with the corrected fact.
5) Do not mention tool calls in the final user-facing response.`;

type Provider = "claude" | "chatgpt" | "gemini" | "cursor";

/* ── Provider icons ────────────────────────────────────────── */
function ClaudeIcon() {
  return (
    <img src="/claude.svg" alt="Claude" width={24} height={24} aria-hidden="true" />
  );
}

function ChatGPTIcon() {
  return (
    <img src="/chatgpt.svg" alt="ChatGPT" width={24} height={24} aria-hidden="true" />
  );
}

function CursorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M16.5 12l-7.5 7.5v-15l7.5 7.5z" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function GeminiIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2C12 7.52 7.52 12 2 12C7.52 12 12 16.48 12 22C12 16.48 16.48 12 22 12C16.48 12 12 7.52 12 2Z" fill="#4B90FF" />
    </svg>
  );
}

/* ── Code block ────────────────────────────────────────────── */
function CodeBlock({ value, onCopy }: { value: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {/* ignore */}
  };

  return (
    <div className="cnn-code-block">
      <code className="cnn-code-text">{value}</code>
      <button
        type="button"
        className={`cnn-copy-corner ${copied ? "copied" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy"}
        aria-label="Copy to clipboard"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/* ── Claude setup ──────────────────────────────────────────── */
function ClaudeSetup({ onBack }: { onBack: () => void }) {
  const [installedBridge, setInstalledBridge] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [restartedClaude, setRestartedClaude] = useState(false);
  const isComplete = installedBridge && signedIn && restartedClaude;

  const claudeDesktopConfig = `{
  "mcpServers": {
    "tallei": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-bridge.js", "connect"],
      "env": {
        "MCP_URL": "https://your-domain.example/mcp"
      }
    }
  }
}`;

  const stepOneClass = installedBridge ? "done" : "active";
  const stepTwoClass = signedIn ? "done" : installedBridge ? "active" : "upcoming";
  const stepThreeClass = restartedClaude ? "done" : signedIn ? "active" : "upcoming";

  return (
    <div className="su-root">
      <button type="button" className="cnn-back" onClick={onBack}>
        ← Back to integrations
      </button>

      <div className="su-header">
        <div className="su-header-left">
          <div className="su-eyebrow">
            <span className="lp-live-dot" style={{ width: 6, height: 6 }}></span>
            Claude Desktop
          </div>
          <h1 className="su-title">Connect Claude</h1>
          <p className="su-desc">Enable persistent memory across all your Claude conversations.</p>
        </div>
      </div>

      <div className="su-steps">
        <div className={`su-step ${stepOneClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">1</div>
            <div className="su-step-line" />
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Install Claude MCP Bridge</div>
            <div className="su-step-content">
              <p className="su-step-body">Run the helper to register the local MCP bridge in Claude Desktop.</p>
              <CodeBlock value="npm run setup:claude" />
              <div className="su-step-actions">
                <button className="su-btn-primary" onClick={() => setInstalledBridge(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`su-step ${stepTwoClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">2</div>
            <div className="su-step-line" />
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Sign In with OAuth</div>
            <div className="su-step-content">
              <p className="su-step-body">
                Run OAuth login once. This opens your browser and stores a refreshable local bridge session.
              </p>
              <CodeBlock value="node mcp-bridge.js login" />
              <p className="su-step-body" style={{ marginTop: "0.8rem" }}>
                If needed, your Claude Desktop config should look like this:
              </p>
              <CodeBlock value={claudeDesktopConfig} />
              <div className="su-step-actions">
                <button className="su-btn-primary" disabled={!installedBridge} onClick={() => setSignedIn(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`su-step ${stepThreeClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">3</div>
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Restart Claude</div>
            <div className="su-step-content">
              <p className="su-step-body">
                Restart Claude Desktop and verify Tallei appears in MCP tools.
              </p>
              <div className="su-step-actions">
                <button className="su-btn-primary" disabled={!signedIn} onClick={() => setRestartedClaude(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Success */}
      {isComplete && (
        <div className="su-success animate-fade-up">
          <div className="su-success-icon">
            <Check size={18} strokeWidth={3} />
          </div>
          <div>
            <h3 className="su-success-title">Connection successful</h3>
            <p className="su-success-desc">Claude is now connected using OAuth-secured MCP access.</p>
          </div>
          <div className="su-success-link">
            <Link href="/dashboard" className="su-btn-ghost">View Memories</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ChatGPT setup ─────────────────────────────────────────── */
function ChatGptSetup({ onBack }: { onBack: () => void }) {
  const [openApiImported, setOpenApiImported] = useState(false);
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const [tokenUrlCopied, setTokenUrlCopied] = useState(false);
  const [builderConfigured, setBuilderConfigured] = useState(false);
  const [published, setPublished] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);
  const oauthConfigured = authUrlCopied && tokenUrlCopied;
  const isComplete = openApiImported && oauthConfigured && builderConfigured && published;

  const openApiUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/chatgpt/openapi.json`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/chatgpt/openapi.json`;
  const authorizationUrl = typeof window !== "undefined"
    ? `${window.location.origin}/authorize`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/authorize`;
  const tokenUrl = typeof window !== "undefined"
    ? `${window.location.origin}/token`
    : `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/token`;

  const copyInstructions = async () => {
    await navigator.clipboard.writeText(CHATGPT_INSTRUCTIONS_TEMPLATE).catch(() => {});
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 2000);
  };

  const stepOneClass = openApiImported ? "done" : "active";
  const stepTwoClass = oauthConfigured ? "done" : openApiImported ? "active" : "upcoming";
  const stepThreeClass = builderConfigured ? "done" : oauthConfigured ? "active" : "upcoming";
  const stepFourClass = published ? "done" : builderConfigured ? "active" : "upcoming";

  return (
    <div className="su-root">
      <button type="button" className="cnn-back" onClick={onBack}>
        ← Back to integrations
      </button>

      <div className="su-header">
        <div className="su-header-left">
          <div className="su-eyebrow">
            <span className="lp-live-dot" style={{ width: 6, height: 6 }}></span>
            Custom GPTs
          </div>
          <h1 className="su-title">Connect ChatGPT</h1>
          <p className="su-desc">Set up a Custom GPT Action using OAuth. Legacy API keys are disabled.</p>
        </div>
      </div>

      <div className="su-steps">
        <div className={`su-step ${stepOneClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">1</div>
            <div className="su-step-line" />
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Copy OpenAPI Schema</div>
            <div className="su-step-content">
              <p className="su-step-body">Copy your OpenAPI schema URL and import it in GPT Actions.</p>
              <CodeBlock value={openApiUrl} onCopy={() => setOpenApiImported(true)} />
              <div className="su-step-actions">
                <button className="su-btn-primary" onClick={() => setOpenApiImported(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`su-step ${stepTwoClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">2</div>
            <div className="su-step-line" />
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Copy OAuth Endpoints</div>
            <div className="su-step-content">
              <p className="su-step-body">Configure OAuth for the Action using these two endpoints.</p>
              <p className="cnn-provider-sub" style={{ marginBottom: "0.35rem" }}>Authorization URL</p>
              <CodeBlock value={authorizationUrl} onCopy={() => setAuthUrlCopied(true)} />
              <p className="cnn-provider-sub" style={{ marginTop: "0.8rem", marginBottom: "0.35rem" }}>Token URL</p>
              <CodeBlock value={tokenUrl} onCopy={() => setTokenUrlCopied(true)} />
              <div className="su-step-actions">
                <button
                  className="su-btn-primary"
                  disabled={!authUrlCopied || !tokenUrlCopied}
                  onClick={() => {
                    setAuthUrlCopied(true);
                    setTokenUrlCopied(true);
                  }}
                >
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`su-step ${stepThreeClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">3</div>
            <div className="su-step-line" />
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Configure GPT Builder</div>
            <div className="su-step-content">
              <p className="su-step-body">Create the Action and configure OAuth in GPT Builder.</p>
              <ol className="cnn-list">
                <li>Open GPT Builder and switch to <strong>Configure</strong></li>
                <li>Create a new action and import your OpenAPI URL</li>
                <li>Set auth to <strong>OAuth</strong>, then paste Authorization URL + Token URL</li>
                <li>Requested scopes: <code>memory:read memory:write</code></li>
              </ol>
              <div className="su-step-actions">
                <button
                  type="button"
                  className="su-btn-ghost"
                  onClick={() => window.open(CHATGPT_BUILDER_URL, "_blank", "noopener,noreferrer")}
                >
                  Open GPT Builder <ExternalLink size={14} />
                </button>
                <button className="su-btn-primary" disabled={!oauthConfigured} onClick={() => setBuilderConfigured(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`su-step ${stepFourClass}`}>
          <div className="su-step-aside">
            <div className="su-step-num">4</div>
          </div>
          <div className="su-step-main">
            <div className="su-step-title">Add Instructions & Publish</div>
            <div className="su-step-content">
              <p className="su-step-body">Paste these instructions into the <strong>Instructions</strong> field, then publish.</p>
              <textarea
                readOnly
                className="su-instruction-box"
                value={CHATGPT_INSTRUCTIONS_TEMPLATE}
              />
              <div className="su-step-actions">
                <button type="button" className="su-btn-ghost" onClick={copyInstructions}>
                  {copiedInstructions ? "Copied!" : "Copy instructions"}
                </button>
                <button className="su-btn-primary" disabled={!builderConfigured} onClick={() => setPublished(true)}>
                  Mark step done
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up">
          <div className="su-success-icon">
            <Check size={18} strokeWidth={3} />
          </div>
          <div>
            <h3 className="su-success-title">Connection successful</h3>
            <p className="su-success-desc">ChatGPT is now connected with OAuth-based access.</p>
          </div>
          <div className="su-success-link">
            <Link href="/dashboard" className="su-btn-ghost">View Memories</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Generic setup (Gemini/Cursor) ─────────────────────────── */
function GenericSetup({ provider, name, icon: Icon, onBack }: { provider: Provider; name: string; icon: React.FC; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [isComplete, setIsComplete] = useState(false);

  return (
    <div className="su-root">
      <button type="button" className="cnn-back" onClick={onBack}>
        ← Back to integrations
      </button>

      <div className="su-header">
        <div className="su-header-left">
          <div className="su-eyebrow">
            <span className="lp-live-dot" style={{ width: 6, height: 6 }}></span>
            {name} Integration
          </div>
          <h1 className="su-title">Connect {name}</h1>
          <p className="su-desc">Connect Tallei to {name} using standard MCP/OAuth configurations.</p>
        </div>
      </div>

      <div className="su-steps">
        <div className={`su-step ${isComplete ? "done" : "active"}`}>
          <div className="su-step-aside">
            <div className="su-step-num" onClick={() => setStep(0)}>1</div>
          </div>
          <div className="su-step-main">
            <button className="su-step-title" onClick={() => setStep(0)}>Configure {name}</button>
            {step === 0 && !isComplete && (
              <div className="su-step-content animate-fade-in">
                <p className="su-step-body">Add the required configurations into your {name} settings. You can find detailed instructions in the Tallei docs.</p>
                <div className="su-step-actions">
                  <button className="su-btn-primary" onClick={() => { setStep(1); setIsComplete(true); }}>
                    Complete Setup
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up">
          <div className="su-success-icon">
            <Check size={18} strokeWidth={3} />
          </div>
          <div>
            <h3 className="su-success-title">Connection successful</h3>
            <p className="su-success-desc">Your AI is now connected to Tallei.</p>
          </div>
          <div className="su-success-link">
            <Link href="/dashboard" className="su-btn-ghost">View Memories</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Selector ──────────────────────────────────────────────── */
function ProviderSelector({
  onSelect,
}: {
  onSelect: (p: Provider) => void;
}) {
  const providers: { id: Provider; name: string; sub: string; icon: React.FC }[] = [
    { id: "claude", name: "Claude", sub: "Desktop & Web via MCP", icon: ClaudeIcon },
    { id: "chatgpt", name: "ChatGPT", sub: "Custom GPT with Actions", icon: ChatGPTIcon },
  ];

  return (
    <div className="cnn-wrap">
      <div className="cnn-hero">
        <h1 className="cnn-title">Choose your AI</h1>
        <p className="cnn-subtitle">Connect Tallei to your favorite platforms to enable infinite memory.</p>
      </div>

      <div style={{
        background: "#0d1219",
        border: "1px solid #1e2a38",
        borderRadius: "16px",
        overflow: "hidden"
      }}>
        {providers.map((p) => (
          <button
            key={p.id}
            className="cnn-provider-row"
            onClick={() => onSelect(p.id)}
          >
            <div className="cnn-provider-icon" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p.icon />
            </div>
            <div style={{ flex: 1 }}>
              <div className="cnn-provider-name">{p.name}</div>
              <div className="cnn-provider-sub">{p.sub}</div>
            </div>
            <div style={{ color: "#3f4654" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────── */
export default function ConnectorsPage() {
  const [selected, setSelected] = useState<Provider | null>(null);

  if (selected === "claude") return <ClaudeSetup onBack={() => setSelected(null)} />;
  if (selected === "chatgpt") return <ChatGptSetup onBack={() => setSelected(null)} />;

  return (
    <ProviderSelector onSelect={setSelected} />
  );
}

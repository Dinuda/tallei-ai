"use client";

import Link from "next/link";
import { useState } from "react";
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
              <div className="su-step-title">Copy MCP URL</div>
              <p className="su-step-body">Copy your Tallei MCP endpoint URL to use in Claude.</p>
            </div>
          </div>
          <div className="su-step-right">
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
              <p className="su-step-body">In Claude, click <strong>Add custom connector</strong>, paste your MCP URL, and save.</p>
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
function ChatGptSetup() {
  const [copiedInstructions, setCopiedInstructions] = useState(false);

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

  return (
    <div className="su-root animate-fade-in">
      <div className="su-steps-grid">
        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">1</div>
            <div className="su-step-text">
              <div className="su-step-title">Copy OpenAPI Schema</div>
              <p className="su-step-body">Copy your OpenAPI schema URL and import it in GPT Actions.</p>
            </div>
          </div>
          <div className="su-step-right">
            <CodeBlock value={openApiUrl} language="url" />
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">2</div>
            <div className="su-step-text">
              <div className="su-step-title">Copy Endpoints</div>
              <p className="su-step-body">Configure OAuth for the Action using these two endpoints.</p>
            </div>
          </div>
          <div className="su-step-right">
            <div style={{ marginBottom: "0.5rem" }}><strong style={{ fontSize: "0.85rem", color: "var(--text)" }}>Authorization URL</strong></div>
            <CodeBlock value={authorizationUrl} language="url" />
            <div style={{ marginTop: "1rem", marginBottom: "0.5rem" }}><strong style={{ fontSize: "0.85rem", color: "var(--text)" }}>Token URL</strong></div>
            <CodeBlock value={tokenUrl} language="url" />
          </div>
        </div>

        <div className="su-step-row">
          <div className="su-step-left">
            <div className="su-step-num">3</div>
            <div className="su-step-text">
              <div className="su-step-title">Configure Builder</div>
              <p className="su-step-body">Create the Action and configure OAuth in GPT Builder.</p>
            </div>
          </div>
          <div className="su-step-right">
            <ol className="cnn-list" style={{marginBottom: '1rem'}}>
              <li>Open GPT Builder and switch to <strong>Configure</strong></li>
              <li>Create a new action and import your OpenAPI URL</li>
              <li>Set auth to <strong>OAuth</strong>, then paste Authorization URL + Token URL</li>
              <li>Requested scopes: <code>memory:read memory:write</code></li>
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
              <div className="su-step-title">Publish</div>
              <p className="su-step-body">Paste these instructions into the <strong>Instructions</strong> field, then publish.</p>
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

  const providers: { id: Provider; name: string; sub: string; icon: React.FC }[] = [
    { id: "claude", name: "Claude MCP", sub: "Memory across every session", icon: ClaudeIcon },
    { id: "chatgpt", name: "ChatGPT Action", sub: "Drop into your Custom GPT", icon: ChatGPTIcon },
  ];

  return (
    <div className="cnn-wrap" style={{maxWidth: '1000px'}}>
      <div className="cnn-hero" style={{textAlign: 'left', paddingBottom: '1.5rem', paddingTop: '1rem'}}>
        <h1 className="cnn-title" style={{fontSize: '2rem'}}>Connect Tallei</h1>
      </div>

      <div className="cnn-provider-row-container" style={{justifyContent: 'flex-start', marginBottom: '2rem'}}>
        {providers.map((p) => (
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
               </div>
            </div>
          </div>
        ))}
      </div>

      {selected === "claude" && <ClaudeSetup />}
      {selected === "chatgpt" && <ChatGptSetup />}
    </div>
  );
}

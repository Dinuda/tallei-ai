"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Plug,
  Terminal,
} from "lucide-react";

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

export default function SetupPage() {
  const appUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_API_BASE_URL || "";
  const connectorUrl = `${appUrl}/mcp`;
  const chatgptOpenApiUrl = `${appUrl}/api/chatgpt/openapi.json`;

  const [provider, setProvider] = useState<Provider>("claude");
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="su-root">
      <div className="su-provider-tabs" role="tablist" aria-label="Setup providers">
        <button
          type="button"
          role="tab"
          aria-selected={provider === "claude"}
          className={`su-provider-tab${provider === "claude" ? " active" : ""}`}
          onClick={() => setProvider("claude")}
        >
          Claude
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={provider === "chatgpt"}
          className={`su-provider-tab${provider === "chatgpt" ? " active" : ""}`}
          onClick={() => setProvider("chatgpt")}
        >
          ChatGPT
        </button>
      </div>

      {provider === "claude" ? (
        <ClaudeSetup connectorUrl={connectorUrl} onToast={showToast} />
      ) : (
        <ChatGptSetup openApiUrl={chatgptOpenApiUrl} onToast={showToast} />
      )}

      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </div>
  );
}

function ClaudeSetup({
  connectorUrl,
  onToast,
}: {
  connectorUrl: string;
  onToast: (message: string) => void;
}) {
  const [activeStep, setActiveStep] = useState<number>(1);
  const [copied, setCopied] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const stepStatus = (id: number): StepStatus => {
    if (id < activeStep) return "done";
    if (id === activeStep) return "active";
    return "upcoming";
  };

  const copyUrl = async (): Promise<boolean> => {
    setCopyWarning(null);
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      onToast("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setCopyWarning(
        "Clipboard blocked — copy the URL manually from the field below."
      );
      onToast("Could not copy automatically");
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

  const onConnectorAdded = () => setActiveStep((p) => Math.max(p, 4));

  const onFinish = () => {
    setIsComplete(true);
    setActiveStep(5);
  };

  return (
    <>
      <div className="su-header">
        <div className="su-header-left">
          <span className="su-eyebrow">
            <Plug size={11} />
            Claude Connector
          </span>
          <h1 className="su-title">Connect Claude to Tallei</h1>
          <p className="su-desc">
            4-step setup — no local config required.
          </p>
        </div>
        <button type="button" className="su-cta" onClick={onOpenClaude}>
          Open Claude Settings
          <ExternalLink size={14} />
        </button>
      </div>

      <div className="su-url-card">
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
            title="Copy MCP URL"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {copyWarning && <p className="su-url-warning">{copyWarning}</p>}
      </div>

      <div className="su-steps">
        <Step
          number={1}
          totalSteps={4}
          status={stepStatus(1)}
          title="Copy MCP URL"
          onActivate={() => setActiveStep(1)}
        >
          <p className="su-step-body">
            Copy your endpoint above so it&apos;s ready before opening Claude.
          </p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onCopy}>
              {copied ? (
                <>
                  <Check size={14} /> URL copied
                </>
              ) : (
                <>
                  <Copy size={14} /> Copy URL
                </>
              )}
            </button>
            <button
              type="button"
              className="su-btn-ghost"
              onClick={() => setActiveStep((p) => Math.max(p, 2))}
            >
              Skip
              <ArrowRight size={13} />
            </button>
          </div>
        </Step>

        <Step
          number={2}
          totalSteps={4}
          status={stepStatus(2)}
          title="Open Claude Settings"
          onActivate={() => setActiveStep(2)}
        >
          <p className="su-step-body">
            Navigate to Claude&apos;s connector settings. The URL will be copied
            automatically.
          </p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onOpenClaude}>
              Open Claude + Copy URL
              <ExternalLink size={13} />
            </button>
            <a
              href={CLAUDE_CONNECTORS_URL}
              target="_blank"
              rel="noreferrer"
              className="su-btn-ghost"
            >
              Open only
              <ExternalLink size={13} />
            </a>
          </div>
          <p className="su-step-hint">
            If copy is blocked, Claude still opens and you can paste manually.
          </p>
        </Step>

        <Step
          number={3}
          totalSteps={4}
          status={stepStatus(3)}
          title="Add Custom Connector"
          onActivate={() => setActiveStep(3)}
        >
          <ol className="su-checklist">
            <li>
              In Claude settings, click <strong>Add custom connector</strong>
            </li>
            <li>Paste your MCP URL and save</li>
          </ol>
          <button type="button" className="su-btn-primary" onClick={onConnectorAdded}>
            Done — connector added
            <Check size={14} />
          </button>
        </Step>

        <Step
          number={4}
          totalSteps={4}
          status={stepStatus(4)}
          title="Authorize and Connect"
          onActivate={() => setActiveStep(4)}
        >
          <ol className="su-checklist">
            <li>Find <strong>Tallei</strong> in the connectors list</li>
            <li>Click <strong>Connect</strong> and approve access</li>
          </ol>
          <div className="su-step-actions">
            <a
              href={CLAUDE_CONNECTORS_URL}
              target="_blank"
              rel="noreferrer"
              className="su-btn-ghost"
            >
              Go to Claude
              <ExternalLink size={13} />
            </a>
            <button type="button" className="su-btn-primary" onClick={onFinish}>
              Finish setup
              <Check size={14} />
            </button>
          </div>
        </Step>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up">
          <div className="su-success-icon">
            <Check size={18} />
          </div>
          <div>
            <p className="su-success-title">You&apos;re connected</p>
            <p className="su-success-desc">
              Claude is now linked to Tallei. Memory syncing is active.
            </p>
          </div>
          <Link href="/dashboard/memory" className="su-btn-ghost su-success-link">
            View memories
            <ArrowRight size={13} />
          </Link>
        </div>
      )}

      <p className="su-footnote">
        <strong>Using Claude Desktop locally?</strong> You can also configure via{" "}
        <code>claude_desktop_config.json</code>. Claude.ai connectors require a
        publicly reachable HTTPS URL.
      </p>
    </>
  );
}

function ChatGptSetup({
  openApiUrl,
  onToast,
}: {
  openApiUrl: string;
  onToast: (message: string) => void;
}) {
  const [activeStep, setActiveStep] = useState(1);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedOpenApi, setCopiedOpenApi] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  const stepStatus = (id: number): StepStatus => {
    if (id < activeStep) return "done";
    if (id === activeStep) return "active";
    return "upcoming";
  };

  const copyValue = async (value: string, successMessage: string): Promise<boolean> => {
    setCopyWarning(null);
    try {
      await navigator.clipboard.writeText(value);
      onToast(successMessage);
      return true;
    } catch {
      setCopyWarning(
        "Clipboard blocked — copy manually from the field below."
      );
      onToast("Could not copy automatically");
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
        body: JSON.stringify({ name: "ChatGPT Actions" }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.key !== "string") {
        throw new Error(data?.error || "Failed to generate API key");
      }

      setGeneratedKey(data.key);
      setActiveStep((p) => Math.max(p, 2));
      onToast("API key generated");
    } catch (error) {
      const message = error instanceof Error
          ? error.message
          : "Failed to generate API key";
      setCopyWarning(message);
      onToast("API key generation failed");
    } finally {
      setGeneratingKey(false);
    }
  };

  const onCopyKey = async () => {
    if (!generatedKey) return;
    const ok = await copyValue(generatedKey, "API key copied");
    if (!ok) return;
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const onCopyOpenApi = async () => {
    const ok = await copyValue(openApiUrl, "OpenAPI URL copied");
    if (!ok) return;
    setCopiedOpenApi(true);
    setTimeout(() => setCopiedOpenApi(false), 2000);
    setActiveStep((p) => Math.max(p, 3));
  };

  const onOpenBuilder = () => {
    window.open(CHATGPT_BUILDER_URL, "_blank", "noopener,noreferrer");
    setActiveStep((p) => Math.max(p, 4));
  };

  const onCopyInstructions = async () => {
    const ok = await copyValue(
      CHATGPT_INSTRUCTIONS_TEMPLATE,
      "Instructions copied"
    );
    if (!ok) return;
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 2000);
  };

  const onFinish = () => {
    setIsComplete(true);
    setActiveStep(6);
  };

  return (
    <>
      <div className="su-header">
        <div className="su-header-left">
          <span className="su-eyebrow">
            <Plug size={11} />
            ChatGPT Actions
          </span>
          <h1 className="su-title">Connect ChatGPT to Tallei</h1>
          <p className="su-desc">
            5-step setup for Custom GPT Actions with shared memory.
          </p>
        </div>
        <button type="button" className="su-cta" onClick={onOpenBuilder}>
          Open GPT Builder
          <ExternalLink size={14} />
        </button>
      </div>

      <div className="su-url-card">
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
            title="Copy OpenAPI URL"
          >
            {copiedOpenApi ? <Check size={14} /> : <Copy size={14} />}
            {copiedOpenApi ? "Copied" : "Copy"}
          </button>
        </div>
        {copyWarning && <p className="su-url-warning">{copyWarning}</p>}
      </div>

      <div className="su-steps">
        <Step
          number={1}
          totalSteps={5}
          status={stepStatus(1)}
          title="Generate API Key"
          onActivate={() => setActiveStep(1)}
        >
          <p className="su-step-body">
            Create a dedicated key for ChatGPT Actions. This secret is shown once.
          </p>
          <div className="su-step-actions">
            <button
              type="button"
              className="su-btn-primary"
              disabled={generatingKey}
              onClick={generateApiKey}
            >
              {generatingKey ? "Generating..." : "Generate key"}
            </button>
            <button
              type="button"
              className="su-btn-ghost"
              disabled={!generatedKey}
              onClick={onCopyKey}
            >
              {copiedKey ? (
                <>
                  <Check size={13} /> Key copied
                </>
              ) : (
                <>
                  <Copy size={13} /> Copy key
                </>
              )}
            </button>
            <button
              type="button"
              className="su-btn-ghost"
              onClick={() => setActiveStep((p) => Math.max(p, 2))}
            >
              Continue
              <ArrowRight size={13} />
            </button>
          </div>
          {generatedKey && (
            <div className="su-inline-secret">
              <p className="su-inline-secret-note">
                Save this key now. For security, it will not be shown again.
              </p>
              <div className="su-url-row">
                <code className="su-url-text">{generatedKey}</code>
              </div>
            </div>
          )}
        </Step>

        <Step
          number={2}
          totalSteps={5}
          status={stepStatus(2)}
          title="Copy OpenAPI URL"
          onActivate={() => setActiveStep(2)}
        >
          <p className="su-step-body">
            In GPT Builder Actions, import from this URL so ChatGPT gets your
            memory endpoints.
          </p>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onCopyOpenApi}>
              {copiedOpenApi ? (
                <>
                  <Check size={13} /> OpenAPI URL copied
                </>
              ) : (
                <>
                  <Copy size={13} /> Copy OpenAPI URL
                </>
              )}
            </button>
            <button
              type="button"
              className="su-btn-ghost"
              onClick={() => setActiveStep((p) => Math.max(p, 3))}
            >
              Continue
              <ArrowRight size={13} />
            </button>
          </div>
        </Step>

        <Step
          number={3}
          totalSteps={5}
          status={stepStatus(3)}
          title="Open GPT Builder + Configure"
          onActivate={() => setActiveStep(3)}
        >
          <p className="su-step-body">
            Open GPT Builder. It starts on the <strong>Create</strong> tab, then
            click <strong>Configure</strong> at the top before adding Actions.
          </p>
          <div className="su-inline-secret">
            <p className="su-inline-secret-note">
              Optional: paste this in the Create chat to auto-fill draft name/description.
            </p>
            <div className="su-url-row">
              <code className="su-url-text">{CHATGPT_BUILDER_BOOTSTRAP_PROMPT}</code>
            </div>
          </div>
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onOpenBuilder}>
              Open GPT Builder
              <ExternalLink size={13} />
            </button>
            <a
              href={CHATGPT_BUILDER_URL}
              target="_blank"
              rel="noreferrer"
              className="su-btn-ghost"
            >
              Open only
              <ExternalLink size={13} />
            </a>
          </div>
        </Step>

        <Step
          number={4}
          totalSteps={5}
          status={stepStatus(4)}
          title="Configure GPT + Add Action"
          onActivate={() => setActiveStep(4)}
        >
          <ol className="su-checklist">
            <li>In the <strong>Configure</strong> tab, scroll to <strong>Actions</strong></li>
            <li>Click <strong>Create new action</strong></li>
            <li>Choose <strong>Import from URL</strong> and paste the OpenAPI URL</li>
            <li>
              Set authentication to <strong>API Key</strong> in header
              <code>Authorization</code> with value <code>Bearer gm_...</code>
            </li>
            <li>Save/Update the action</li>
          </ol>
          <button
            type="button"
            className="su-btn-primary"
            onClick={() => setActiveStep((p) => Math.max(p, 5))}
          >
            Done — actions configured
            <Check size={14} />
          </button>
        </Step>

        <Step
          number={5}
          totalSteps={5}
          status={stepStatus(5)}
          title="Configure Instructions + Publish"
          onActivate={() => setActiveStep(5)}
        >
          <p className="su-step-body">
            In <strong>Configure</strong>, paste this into the GPT
            <strong> Instructions</strong> field, then publish/save the GPT.
          </p>
          <textarea
            className="su-instruction-box"
            readOnly
            value={CHATGPT_INSTRUCTIONS_TEMPLATE}
            aria-label="ChatGPT memory instructions"
          />
          <div className="su-step-actions">
            <button type="button" className="su-btn-primary" onClick={onCopyInstructions}>
              {copiedInstructions ? (
                <>
                  <Check size={13} /> Instructions copied
                </>
              ) : (
                <>
                  <Copy size={13} /> Copy instructions
                </>
              )}
            </button>
            <button type="button" className="su-btn-ghost" onClick={onFinish}>
              Finish setup
              <Check size={13} />
            </button>
          </div>
        </Step>
      </div>

      {isComplete && (
        <div className="su-success animate-fade-up">
          <div className="su-success-icon">
            <Check size={18} />
          </div>
          <div>
            <p className="su-success-title">ChatGPT is connected</p>
            <p className="su-success-desc">
              Shared memory sync is active through your Actions API key.
            </p>
          </div>
          <Link href="/dashboard/memory" className="su-btn-ghost su-success-link">
            View memories
            <ArrowRight size={13} />
          </Link>
        </div>
      )}

      <p className="su-footnote">
        Use the same Tallei user/API-key context across Claude and ChatGPT to
        share one memory graph.
      </p>
    </>
  );
}

function Step({
  number,
  totalSteps = 4,
  status,
  title,
  onActivate,
  children,
}: {
  number: number;
  totalSteps?: number;
  status: StepStatus;
  title: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const isActive = status === "active";
  const isDone = status === "done";
  const isUpcoming = status === "upcoming";

  return (
    <div
      className={`su-step${isActive ? " active" : ""}${isDone ? " done" : ""}${isUpcoming ? " upcoming" : ""}`}
    >
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
        {isActive && (
          <div className="su-step-content animate-fade-up">{children}</div>
        )}
      </div>
    </div>
  );
}

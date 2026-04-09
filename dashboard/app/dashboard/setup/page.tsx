"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  ArrowRight,
  Plug,
  Terminal,
} from "lucide-react";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

type StepStatus = "done" | "active" | "upcoming";

export default function SetupPage() {
  const appUrl =
    typeof window !== "undefined"
      ? process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin
      : process.env.NEXT_PUBLIC_API_BASE_URL || "";
  const connectorUrl = `${appUrl}/mcp`;

  const [activeStep, setActiveStep] = useState<number>(1);
  const [copied, setCopied] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
      setToast("Copied to clipboard");
      setTimeout(() => {
        setToast(null);
        setCopied(false);
      }, 2000);
      return true;
    } catch {
      setCopyWarning(
        "Clipboard blocked — copy the URL manually from the field below."
      );
      setToast("Could not copy automatically");
      setTimeout(() => setToast(null), 2000);
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
    <div className="su-root">
      {/* Header */}
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

      {/* MCP URL block */}
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

      {/* Steps timeline */}
      <div className="su-steps">
        <Step
          number={1}
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
          status={stepStatus(2)}
          title="Open Claude Settings"
          onActivate={() => setActiveStep(2)}
        >
          <p className="su-step-body">
            Navigate to Claude&apos;s connector settings. The URL will be copied automatically.
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
          status={stepStatus(3)}
          title="Add Custom Connector"
          onActivate={() => setActiveStep(3)}
        >
          <ol className="su-checklist">
            <li>In Claude settings, click <strong>Add custom connector</strong></li>
            <li>Paste your MCP URL and save</li>
          </ol>
          <button type="button" className="su-btn-primary" onClick={onConnectorAdded}>
            Done — connector added
            <Check size={14} />
          </button>
        </Step>

        <Step
          number={4}
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

      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </div>
  );
}

function Step({
  number,
  status,
  title,
  onActivate,
  children,
}: {
  number: number;
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
        {number < 4 && <div className="su-step-line" />}
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

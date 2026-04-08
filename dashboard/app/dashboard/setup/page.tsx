"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

type StepStatus = "done" | "active" | "upcoming";

interface Step {
  id: number;
  title: string;
  subtitle: string;
}

const STEPS: Step[] = [
  { id: 1, title: "Copy MCP URL", subtitle: "Keep your connector endpoint ready" },
  { id: 2, title: "Go to Claude", subtitle: "Open connector settings and continue" },
  { id: 3, title: "Add Custom Connector", subtitle: "Paste URL and save connector" },
  { id: 4, title: "Authorize and Connect", subtitle: "Approve access to complete setup" },
];

export default function SetupPage() {
  const appUrl = typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin)
    : (process.env.NEXT_PUBLIC_API_BASE_URL || "");
  const connectorUrl = `${appUrl}/mcp`;

  const [activeStep, setActiveStep] = useState<number>(1);
  const [copied, setCopied] = useState(false);
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const progress = useMemo(() => {
    const completed = Math.max(0, Math.min(4, activeStep - 1));
    return (completed / 4) * 100;
  }, [activeStep]);

  const stepStatus = (stepId: number): StepStatus => {
    if (stepId < activeStep) return "done";
    if (stepId === activeStep) return "active";
    return "upcoming";
  };

  const copyConnectorUrl = async (): Promise<boolean> => {
    setCopyWarning(null);
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      setToast("MCP URL copied to clipboard");
      window.setTimeout(() => setToast(null), 1800);
      return true;
    } catch {
      setCopied(false);
      setCopyWarning("Clipboard access was blocked. Copy the MCP URL manually from the field below.");
      setToast("Could not copy automatically");
      window.setTimeout(() => setToast(null), 2000);
      return false;
    }
  };

  const openClaude = (): void => {
    window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener,noreferrer");
  };

  const onCopyOnly = async () => {
    const ok = await copyConnectorUrl();
    if (ok) setActiveStep((prev) => Math.max(prev, 2));
  };

  const onGoToClaudeAndCopy = async () => {
    await copyConnectorUrl();
    openClaude();
    setActiveStep((prev) => Math.max(prev, 3));
  };

  const onConnectorAdded = () => {
    setActiveStep((prev) => Math.max(prev, 4));
  };

  const onAuthorized = () => {
    setIsComplete(true);
    setActiveStep(5);
  };

  return (
    <div className="page-stack" style={{ maxWidth: "920px", width: "100%" }}>
      <section className="setup-hero animate-fade-up">
        <div className="page-header" style={{ alignItems: "center" }}>
          <div>
            <div className="badge badge-accent" style={{ marginBottom: "0.55rem" }}>Setup Guide</div>
            <h2 className="page-title">Connect Claude to Tallei</h2>
            <p className="page-subtitle">4-step guided setup for Claude connectors. No local config required.</p>
          </div>
          <button type="button" className="btn btn-primary btn-lg" onClick={onGoToClaudeAndCopy}>
            Go to Claude + Copy URL
          </button>
        </div>

        <div className="setup-url-box">
          <div style={{ fontSize: "0.74rem", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: "0.4rem" }}>
            MCP URL
          </div>
          <div className="code-block" style={{ userSelect: "all" }}>{connectorUrl}</div>
          {copyWarning && (
            <p style={{ marginTop: "0.55rem", color: "#f8cc95", fontSize: "0.83rem" }}>{copyWarning}</p>
          )}
        </div>
      </section>

      <section className="progress-shell animate-fade-up delay-1">
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="progress-steps-grid">
          {STEPS.map((step) => {
            const status = stepStatus(step.id);
            const badgeBg = status === "done"
              ? "var(--accent)"
              : status === "active"
                ? "#2f3d55"
                : "#3a4659";

            return (
              <button
                key={step.id}
                type="button"
                className={`progress-step ${status === "active" ? "active" : ""} ${status === "upcoming" ? "upcoming" : ""}`}
                onClick={() => status !== "upcoming" && setActiveStep(step.id)}
                disabled={status === "upcoming"}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.2rem" }}>
                  <span className="progress-step-badge" style={{ background: badgeBg }}>
                    {status === "done" ? "OK" : step.id}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Step {step.id}</span>
                </div>
                <div style={{ fontSize: "0.88rem", fontWeight: 700, lineHeight: 1.2 }}>{step.title}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="step-cards">
        <StepCard
          step={1}
          status={stepStatus(1)}
          title="Copy MCP URL"
          subtitle="Copy your endpoint so it is ready before opening Claude settings."
          onActivate={() => setActiveStep(1)}
        >
          <div className="step-actions">
            <button type="button" className="btn btn-primary" onClick={onCopyOnly}>
              {copied ? "Copied URL" : "Copy MCP URL"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setActiveStep((prev) => Math.max(prev, 2))}>
              Continue
            </button>
          </div>
        </StepCard>

        <StepCard
          step={2}
          status={stepStatus(2)}
          title="Go to Claude"
          subtitle="Open Claude connector settings and bring the copied URL with you."
          onActivate={() => setActiveStep(2)}
        >
          <div className="step-actions">
            <button type="button" className="btn btn-primary" onClick={onGoToClaudeAndCopy}>
              Go to Claude + Copy URL
            </button>
            <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer" className="btn btn-secondary">
              Open Claude only
            </a>
          </div>
          <p style={{ marginTop: "0.6rem", fontSize: "0.83rem", color: "var(--text-muted)" }}>
            If copy is blocked, Claude still opens and you can copy manually from the MCP URL field above.
          </p>
        </StepCard>

        <StepCard
          step={3}
          status={stepStatus(3)}
          title="Add Custom Connector"
          subtitle="In Claude, add a custom connector, paste the MCP URL, and save."
          onActivate={() => setActiveStep(3)}
        >
          <ul className="step-card-list">
            <li>Open Claude connector settings.</li>
            <li>Click <strong>Add custom connector</strong>.</li>
            <li>Paste MCP URL and save.</li>
          </ul>
          <button type="button" className="btn btn-primary" onClick={onConnectorAdded}>
            I added the connector
          </button>
        </StepCard>

        <StepCard
          step={4}
          status={stepStatus(4)}
          title="Authorize and Connect"
          subtitle="Finish authorization in Claude to activate memory sync."
          onActivate={() => setActiveStep(4)}
        >
          <ul className="step-card-list">
            <li>Find <strong>Tallei</strong> in Claude connectors.</li>
            <li>Click <strong>Connect</strong>.</li>
            <li>Approve access and return to Claude.</li>
          </ul>
          <div className="step-actions">
            <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer" className="btn btn-secondary">
              Go to Claude
            </a>
            <button type="button" className="btn btn-primary" onClick={onAuthorized}>
              Finish setup
            </button>
          </div>
        </StepCard>
      </section>

      {isComplete && (
        <section className="setup-success animate-fade-up">
          <h3 style={{ marginBottom: "0.3rem" }}>Setup complete</h3>
          <p style={{ fontSize: "0.9rem", marginBottom: "0.55rem" }}>
            Claude is now connected to Tallei. Memory syncing is ready.
          </p>
          <Link href="/dashboard/memory" className="btn btn-secondary btn-sm">Go to Memories</Link>
        </section>
      )}

      {toast && <div role="status" className="toast">{toast}</div>}

      <section className="setup-footer-note">
        <p>
          <strong style={{ color: "var(--text-2)" }}>Local Claude Desktop?</strong>{" "}
          Local setup via <code>claude_desktop_config.json</code> remains available. Claude.ai connectors require a publicly reachable HTTPS MCP URL.
        </p>
      </section>
    </div>
  );
}

function StepCard({
  step,
  status,
  title,
  subtitle,
  onActivate,
  children,
}: {
  step: number;
  status: StepStatus;
  title: string;
  subtitle: string;
  onActivate: () => void;
  children?: React.ReactNode;
}) {
  const isActive = status === "active";
  const isDone = status === "done";
  const isUpcoming = status === "upcoming";

  const badgeBg = isDone ? "var(--accent)" : isActive ? "#2f3d55" : "#3a4659";

  return (
    <article
      className={`step-card ${isActive ? "active" : ""} ${isUpcoming ? "upcoming" : ""}`}
      onClick={isUpcoming ? undefined : onActivate}
      style={{ cursor: isUpcoming ? "default" : "pointer" }}
    >
      <div className="step-card-head">
        <span className="step-card-dot" style={{ background: badgeBg }}>
          {isDone ? "OK" : step}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.2rem" }}>{title}</h3>
          <p style={{ fontSize: "0.87rem", color: "var(--text-muted)" }}>{subtitle}</p>

          {isActive && children && (
            <div className="step-card-content" onClick={(event) => event.stopPropagation()}>
              {children}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

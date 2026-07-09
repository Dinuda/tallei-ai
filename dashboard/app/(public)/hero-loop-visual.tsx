"use client";

import { useEffect, useState } from "react";

const CHAOS_TABS = ["ChatGPT", "Claude", "Gmail", "Docs", "Slack"] as const;
const CHAOS_PROMPTS = [
  "Write this week's newsletter…",
  "Find metrics from last month…",
  "Make it sound more on-brand…",
  "Format and send Friday…",
] as const;

const AGENTS = [
  { initials: "MR", role: "Researcher", tone: "cyan" as const },
  { initials: "BW", role: "Writer", tone: "indigo" as const },
  { initials: "ED", role: "Editor", tone: "cyan" as const },
  { initials: "DL", role: "Deliverer", tone: "indigo" as const },
] as const;

export function HeroLoopVisual() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setActive(true);
      return;
    }
    const timer = window.setTimeout(() => setActive(true), 280);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className={`loops-hero-visual-split${active ? " loops-hero-visual-split--active" : ""}`}
      aria-label="From chaotic manual work to an organized Newsletter Loop"
    >
      <div className="loops-hero-panel loops-hero-panel--chaos">
        <p className="loops-mono loops-hero-panel-label">Manual today</p>
        <div className="loops-chaos-tabs" aria-hidden>
          {CHAOS_TABS.map((tab, index) => (
            <span
              key={tab}
              className="loops-chaos-tab"
              style={{ ["--chaos-i" as string]: index }}
            >
              {tab}
            </span>
          ))}
        </div>
        <ul className="loops-chaos-prompts" aria-hidden>
          {CHAOS_PROMPTS.map((prompt, index) => (
            <li
              key={prompt}
              className="loops-chaos-prompt"
              style={{ ["--chaos-i" as string]: index }}
            >
              {prompt}
            </li>
          ))}
        </ul>
      </div>

      <div className="loops-hero-visual-divider" aria-hidden>
        <span className="loops-hero-visual-arrow">→</span>
      </div>

      <div className="loops-hero-panel loops-hero-panel--flow">
        <div className="loops-hero-panel-header">
          <p className="loops-mono loops-hero-panel-label">Newsletter Loop</p>
          <span className="loops-mono loops-hero-panel-badge">Approval-first</span>
        </div>
        <ol className="loops-hero-agent-flow">
          {AGENTS.map((agent, index) => (
            <li key={agent.role} className="loops-hero-agent-node">
              <div
                className={`loops-agent-avatar loops-agent-avatar--${agent.tone}`}
                aria-hidden
              >
                {agent.initials}
              </div>
              <span className="loops-hero-agent-role">{agent.role}</span>
              {index < AGENTS.length - 1 && (
                <span className="loops-hero-agent-connector" aria-hidden />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

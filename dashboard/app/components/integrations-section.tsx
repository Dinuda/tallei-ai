"use client";

import React, { useState } from "react";
import "../styles/integrations-section.css";

interface Integration {
  id: string;
  name: string;
  color: string;
}

const LIVE_INTEGRATIONS: Integration[] = [
  { id: "chatgpt", name: "ChatGPT", color: "#10a37f" },
  { id: "claude", name: "Claude", color: "#9b87f5" },
  { id: "gemini", name: "Gemini", color: "#4285f4" },
];

const COMING_SOON: Integration[] = [
  { id: "claude-code", name: "Claude Code", color: "#7c3aed" },
  { id: "perplexity", name: "Perplexity", color: "#000000" },
  { id: "openrouter", name: "OpenRouter", color: "#ff6b35" },
  { id: "grok", name: "Grok", color: "#000000" },
];

export function IntegrationsSection() {
  const [activeIntegration] = useState<string>("chatgpt");

  return (
    <section className="integrations-hero" aria-label="AI Integrations">
      {/* Left Column */}
      <div className="integrations-left">
        <span className="integrations-eyebrow">INTEGRATIONS</span>

        <h2 className="integrations-heading">
          Use any AI.<br />
          Tallei keeps <em>them</em> in sync.
        </h2>

        <p className="integrations-description">
          Stay in the tools you love. Tallei runs quietly in the background — syncing your memory and context across every AI you use.
        </p>

        {/* Works With Section */}
        <div className="integrations-works-with">
          <p className="integrations-works-label">Works with</p>
          
          <div className="integrations-logos">
            {LIVE_INTEGRATIONS.map((integration) => (
              <div key={integration.id} className="integrations-logo" title={integration.name}>
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="11" fill={integration.color} opacity="0.1" stroke={integration.color} strokeWidth="2" />
                  <text x="12" y="15" textAnchor="middle" fontSize="8" fontWeight="bold" fill={integration.color}>
                    {integration.name.substring(0, 1)}
                  </text>
                </svg>
              </div>
            ))}
          </div>

          <p className="integrations-more-coming">More coming soon</p>
        </div>
      </div>

      {/* Right Column - ChatGPT Mockup */}
      <div className="integrations-right">
        <div className="integrations-window">
          {/* Window Header */}
          <div className="integrations-window-header">
            <div className="integrations-window-title">
              <svg className="integrations-logo-icon" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10" fill="currentColor" />
              </svg>
              <span>ChatGPT</span>
            </div>
            <div className="integrations-window-badge">Tallei syncing</div>
          </div>

          {/* Window Content */}
          <div className="integrations-window-body">
            {/* Sidebar */}
            <div className="integrations-sidebar">
              <div className="integrations-sidebar-section">
                <h3 className="integrations-sidebar-title">RECENTS</h3>
                <ul className="integrations-recents-list">
                  <li>Brand positioning</li>
                  <li>Agency contract v3</li>
                  <li>Q3 pricing model</li>
                  <li>Hiring brief — eng</li>
                  <li>Onboarding copy</li>
                </ul>
              </div>
            </div>

            {/* Chat Area */}
            <div className="integrations-chat">
              {/* Memory Alert Banner */}
              <div className="integrations-memory-banner">
                <div className="integrations-memory-icon">
                  <div className="integrations-pulse" />
                </div>
                <div className="integrations-memory-content">
                  <p className="integrations-memory-title">Memory from your last session</p>
                  <p className="integrations-memory-text">
                    A via Claude<br />
                    You decided on tiered pricing starting at $49/mo and ruled out usage-based billing until year two. The enterprise tier was left open pending legal review.
                  </p>
                </div>
              </div>

              {/* Messages */}
              <div className="integrations-messages">
                <div className="integrations-message user">
                  <span className="integrations-message-label">Y</span>
                  <p>Given that decision, should we launch with annual-only for the enterprise tier?</p>
                </div>

                <div className="integrations-message bot">
                  <span className="integrations-message-label">ChatGPT</span>
                  <p>Given what you've already worked through, annual-only for enterprise makes sense — it avoids the legal complexity of month-to-month cancellation clauses and gives you predictable ARR from day one. I'd add a 14-day trial with a credit card hold so you're not blocking conversions at the top.</p>
                </div>
              </div>

              {/* Input */}
              <div className="integrations-input-area">
                <input 
                  type="text" 
                  placeholder="Message ChatGPT..." 
                  disabled
                  className="integrations-input"
                />
                <button disabled className="integrations-send-btn">→</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

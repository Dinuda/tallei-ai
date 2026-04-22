"use client";

import Image from "next/image";
import "../styles/integrations-section.css";

interface Integration {
  id: string;
  name: string;
  icon: string;
}

const INTEGRATIONS = [
  { id: "chatgpt", name: "ChatGPT", icon: "/chatgpt.svg" },
  { id: "claude", name: "Claude", icon: "/claude.svg" },
  { id: "gemini", name: "Gemini", icon: "/gemini.svg" },
  { id: "claude-code", name: "Claude Code", icon: "/claude-code.svg" },
  { id: "perplexity", name: "Perplexity", icon: "/perplexity.svg" },
  { id: "openrouter", name: "OpenRouter", icon: "/openrouter.svg" },
  { id: "grok", name: "Grok", icon: "/grok.svg" },
];

export function IntegrationsSection() {
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
            {INTEGRATIONS.map((integration) => (
              <div key={integration.id} className="integrations-logo" title={integration.name}>
                <Image 
                  src={integration.icon} 
                  alt={`${integration.name} logo`} 
                  width={24} 
                  height={24} 
                  className="integrations-logo-img" 
                />
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

"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import "../styles/integrations-section.css";

gsap.registerPlugin(useGSAP);

const INTEGRATIONS = [
  { id: "chatgpt", name: "ChatGPT", icon: "/chatgpt.svg" },
  { id: "claude", name: "Claude", icon: "/claude.svg" },
  { id: "gemini", name: "Gemini", icon: "/gemini.svg" },
  { id: "claude-code", name: "Claude Code", icon: "/claude-code.svg" },
  { id: "perplexity", name: "Perplexity", icon: "/perplexity.svg" },
  { id: "openrouter", name: "OpenRouter", icon: "/openrouter.svg" },
  { id: "grok", name: "Grok", icon: "/grok.svg" },
];

const APPS = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: "/chatgpt.svg",
    memoryVia: "Claude",
    memoryText: "You decided on tiered pricing starting at $49/mo and ruled out usage-based billing until year two. The enterprise tier was left open pending legal review.",
    userMsg: "Given that decision, should we launch with annual-only for the enterprise tier?",
    botMsg: "Given what you've already worked through, annual-only for enterprise makes sense — it avoids the legal complexity of month-to-month cancellation clauses and gives you predictable ARR from day one. I'd add a 14-day trial with a credit card hold so you're not blocking conversions at the top.",
    placeholder: "Message ChatGPT..."
  },
  {
    id: "claude",
    name: "Claude",
    icon: "/claude.svg",
    memoryVia: "Gemini",
    memoryText: "The user prefers to structure all analytical responses with a bolded TL;DR followed by three distinct bullet points. No conversational filler.",
    userMsg: "Summarize the competitor feature matrix I uploaded.",
    botMsg: "**TL;DR:** Competitors lack deep integrations but beat us on pricing.\n\n• **Integrations:** Competitor A only supports basic webhooks.\n• **Pricing:** Average market rate is 30% below our entry tier.\n• **UX:** Their onboarding flow is highly friction-filled.",
    placeholder: "Message Claude..."
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "/gemini.svg",
    memoryVia: "ChatGPT",
    memoryText: "The primary audience for this documentation is non-technical marketing managers. Always use accessible language and analogical examples.",
    userMsg: "Draft the introductory paragraph for the new API connector feature.",
    botMsg: "Think of our new API connector like a universal translator for your favorite tools. Instead of hiring a developer to connect your marketing stack, our connector simply plugs in and lets your platforms speak to each other automatically, saving you hours of manual data entry.",
    placeholder: "Ask Gemini..."
  }
];

export function IntegrationsSection() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-cycle through apps
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % APPS.length);
    }, 5000); // 5 seconds per app

    return () => clearInterval(timer);
  }, []);

  const currentApp = APPS[currentIndex];

  useGSAP(() => {
    // Fade content in when index changes
    gsap.fromTo(
      contentRef.current,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
    );
  }, { dependencies: [currentIndex], scope: containerRef });

  return (
    <section className="integrations-hero" aria-label="AI Integrations" ref={containerRef}>
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

      {/* Right Column - ChatGPT Window Mockup */}
      <div className="integrations-right">
        <div className="integrations-window">
          {/* Window Chrome / Tabs */}
          <div className="integrations-window-header">
            {APPS.map((app, idx) => (
              <div 
                key={app.id} 
                className={`integrations-tab ${idx === currentIndex ? "active" : ""}`}
                onClick={() => setCurrentIndex(idx)}
              >
                <div className="integrations-tab-icon">
                  <Image src={app.icon} alt={app.name} width={16} height={16} />
                </div>
                <span>{app.name}</span>
              </div>
            ))}
            
            <div className="integrations-window-badge-wrap">
              <div className="integrations-window-badge">
                <span className="integrations-badge-dot" />
                Tallei syncing
              </div>
            </div>
          </div>

          {/* Window Content */}
          <div className="integrations-window-body">
            {/* Sidebar */}
            <div className="integrations-sidebar">
              <h3 className="integrations-sidebar-title">RECENTS</h3>
              <ul className="integrations-recents-list">
                <li className="active">Q3 pricing model</li>
                <li>Brand positioning</li>
                <li>Agency contract v3</li>
                <li>Hiring brief — eng</li>
                <li>Onboarding copy</li>
              </ul>
            </div>

            {/* Chat Area */}
            <div className="integrations-chat">
              <div className="integrations-chat-content" ref={contentRef}>
                {/* Memory Alert Banner */}
                <div className="integrations-memory-banner">
                  <div className="integrations-memory-icon">
                    <div className="integrations-pulse" />
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a48ed4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                    </svg>
                  </div>
                  <div className="integrations-memory-content">
                    <p className="integrations-memory-title">Memory from your last session</p>
                    <p className="integrations-memory-text">
                      <span className="integrations-memory-via">A via {currentApp.memoryVia}</span><br />
                      {currentApp.memoryText}
                    </p>
                  </div>
                </div>

                {/* Messages */}
                <div className="integrations-message user">
                  <div className="integrations-message-avatar">Y</div>
                  <div className="integrations-message-body">
                    <p>{currentApp.userMsg}</p>
                  </div>
                </div>

                <div className="integrations-message bot">
                  <div className="integrations-message-avatar">
                    <Image src={currentApp.icon} alt={currentApp.name} width={24} height={24} />
                  </div>
                  <div className="integrations-message-body">
                    <p style={{ whiteSpace: "pre-wrap" }}>{currentApp.botMsg}</p>
                  </div>
                </div>
              </div>

              {/* Input */}
              <div className="integrations-input-area">
                <input 
                  type="text" 
                  placeholder={currentApp.placeholder}
                  disabled
                  className="integrations-input"
                />
                <button disabled className="integrations-send-btn">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

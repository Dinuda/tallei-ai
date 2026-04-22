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
    memoryText: "Project code name is 'Apollo'. We are targeting a Q3 launch. No usage-based billing.",
    userMsg: "Draft an invite for the kickoff meeting.",
    botMsg: "Subject: Kickoff: Project Apollo 🚀\n\nHi team,\n\nLet's align on our Q3 launch for Project Apollo. As discussed, we'll be moving forward with flat-rate pricing only.",
    placeholder: "Message ChatGPT..."
  },
  {
    id: "claude",
    name: "Claude",
    icon: "/claude.svg",
    memoryVia: "Gemini",
    memoryText: "I prefer concise, bulleted responses. No conversational fluff or disclaimers.",
    userMsg: "How do MCP servers work?",
    botMsg: "• **MCP (Model Context Protocol)** standardizes how AI models connect to local data sources.\n• **Architecture:** Client (Claude) ↔️ MCP Server ↔️ Local Data.\n• **Benefit:** Secure, local tool execution without exposing credentials to the cloud.",
    placeholder: "Message Claude..."
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "/gemini.svg",
    memoryVia: "ChatGPT",
    memoryText: "I'm a frontend developer. Default to React (TypeScript) and Tailwind CSS code snippets.",
    userMsg: "How to create a sticky header?",
    botMsg: "```tsx\nexport default function Header() {\n  return (\n    <header className=\"sticky top-0 w-full bg-white/80 backdrop-blur-md border-b z-50\">\n      <nav className=\"flex items-center justify-between p-4\">\n        {/* Nav content */}\n      </nav>\n    </header>\n  );\n}\n```",
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
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a48ed4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="tallei-tally-anim">
                      <line x1="5" y1="4" x2="5" y2="20" className="tally-line t-1" />
                      <line x1="9" y1="4" x2="9" y2="20" className="tally-line t-2" />
                      <line x1="13" y1="4" x2="13" y2="20" className="tally-line t-3" />
                      <line x1="17" y1="4" x2="17" y2="20" className="tally-line t-4" />
                      <line x1="2" y1="16" x2="20" y2="8" className="tally-line t-5" />
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

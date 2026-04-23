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
    memoryText: "I have a severe peanut allergy and travel with my 5-year-old daughter. We prefer quiet, family-friendly spots.",
    userMsg: "Can you suggest 2 places for lunch near Central Park?",
    botMsg: "1. **Friedman's:** 100% peanut-free kitchen and very kid-friendly.\n2. **Bistango:** Awesome allergy protocols and a dedicated kids' menu.\n\nBoth are quiet and just a short walk from the park!",
    placeholder: "Message ChatGPT..."
  },
  {
    id: "claude",
    name: "Claude",
    icon: "/claude.svg",
    memoryVia: "Gemini",
    memoryText: "I run a small bakery. My tone is always warm, friendly, and includes a pastry pun.",
    userMsg: "Reply to an angry customer whose cake was 30 mins late.",
    botMsg: "Hi Sarah,\n\nI am so incredibly sorry for the delay with your cake today! That's certainly not the experience we want to bake into your special day.\n\nI'd love to offer you a full refund—we really want to make this right.",
    placeholder: "Message Claude..."
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "/gemini.svg",
    memoryVia: "ChatGPT",
    memoryText: "I'm a beginner runner training for a 5K. I only have time to run on Tuesdays, Thursdays, and Sundays.",
    userMsg: "Adjust my plan for this week, I'm feeling really sore.",
    botMsg: "No problem! Let's swap Thursday's run for a light 20-minute walk to help you recover. We'll keep Tuesday and Sunday as your main running days. \n\nListen to your body—rest is just as important as running!",
    placeholder: "Ask Gemini..."
  }
];

export function IntegrationsSection() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [displayedUserMsg, setDisplayedUserMsg] = useState("");
  const [isTypingUser, setIsTypingUser] = useState(false);
  const [showMemoryBanner, setShowMemoryBanner] = useState(false);
  const [showBotMsg, setShowBotMsg] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const typeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memoryDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const botDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);

  const clearAnimationTimers = () => {
    if (typeIntervalRef.current) {
      clearInterval(typeIntervalRef.current);
      typeIntervalRef.current = null;
    }
    if (startDelayRef.current) {
      clearTimeout(startDelayRef.current);
      startDelayRef.current = null;
    }
    if (memoryDelayRef.current) {
      clearTimeout(memoryDelayRef.current);
      memoryDelayRef.current = null;
    }
    if (botDelayRef.current) {
      clearTimeout(botDelayRef.current);
      botDelayRef.current = null;
    }
    if (resetDelayRef.current) {
      clearTimeout(resetDelayRef.current);
      resetDelayRef.current = null;
    }
  };

  // Auto-cycle through apps
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % APPS.length);
    }, 12000); // 12 seconds per app to allow reading time and typing

    return () => clearInterval(timer);
  }, []);

  const currentApp = APPS[currentIndex];

  // Typing effect for the user message, then show memory banner and bot message
  useEffect(() => {
    clearAnimationTimers();
    runIdRef.current += 1;
    const runId = runIdRef.current;
    const fullText = currentApp.userMsg;
    let i = 0;

    resetDelayRef.current = setTimeout(() => {
      if (runId !== runIdRef.current) return;
      setDisplayedUserMsg("");
      setIsTypingUser(true);
      setShowMemoryBanner(false);
      setShowBotMsg(false);
    }, 0);

    // Small delay before starting to type
    startDelayRef.current = setTimeout(() => {
      typeIntervalRef.current = setInterval(() => {
        if (runId !== runIdRef.current) return;
        i += 1; 
        if (i >= fullText.length) {
          setDisplayedUserMsg(fullText);
          setIsTypingUser(false);
          if (typeIntervalRef.current) {
            clearInterval(typeIntervalRef.current);
            typeIntervalRef.current = null;
          }
          
          // Show memory banner and bot message slightly after user finishes typing
          memoryDelayRef.current = setTimeout(() => {
            if (runId !== runIdRef.current) return;
            setShowMemoryBanner(true);
            botDelayRef.current = setTimeout(() => {
              if (runId !== runIdRef.current) return;
              setShowBotMsg(true);
            }, 400); // small delay between banner and bot message
          }, 300);
          
        } else {
          setDisplayedUserMsg(fullText.slice(0, i));
        }
      }, 30); // Fast typing speed
    }, 600);

    return () => {
      clearAnimationTimers();
    };
  }, [currentApp.userMsg]);

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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="tallei-tally-anim">
                  <line x1="5" y1="4" x2="5" y2="20" className="tally-line t-1" />
                  <line x1="9" y1="4" x2="9" y2="20" className="tally-line t-2" />
                  <line x1="13" y1="4" x2="13" y2="20" className="tally-line t-3" />
                  <line x1="17" y1="4" x2="17" y2="20" className="tally-line t-4" />
                  <line x1="2" y1="16" x2="20" y2="8" className="tally-line t-5" />
                </svg>
                Memory synced
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
                {/* Messages */}
                <div className="integrations-message user">
                  <div className="integrations-message-avatar">Y</div>
                  <div className="integrations-message-body">
                    <p>
                      {displayedUserMsg}
                      {isTypingUser && <span className="integrations-typing-cursor" />}
                    </p>
                  </div>
                </div>

                {/* Memory Alert Banner */}
                {showMemoryBanner && (
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
                        <span className="integrations-memory-via integrations-memory-via-row">
                          Synced from 
                          <Image 
                            src={currentApp.memoryVia === "Claude" ? "/claude.svg" : currentApp.memoryVia === "ChatGPT" ? "/chatgpt.svg" : "/gemini.svg"} 
                            alt={currentApp.memoryVia} 
                            width={14} 
                            height={14} 
                          />
                          {currentApp.memoryVia}
                        </span><br />
                        {currentApp.memoryText}
                      </p>
                    </div>
                  </div>
                )}

                {showBotMsg && (
                  <div className="integrations-message bot">
                    <div className="integrations-message-avatar">
                      <Image src={currentApp.icon} alt={currentApp.name} width={24} height={24} />
                    </div>
                    <div className="integrations-message-body">
                      <p className="integrations-message-prewrap">
                        {currentApp.botMsg}
                      </p>
                    </div>
                  </div>
                )}
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

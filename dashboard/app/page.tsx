"use client";

import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

/* ─── Component ─────────────────────────────────────────────── */

export default function Home() {
  return (
    <div className="landing-root">



      {/* ═════════════════════════════════════════════════════
          HERO — Grounded, straightforward, human
      ═════════════════════════════════════════════════════ */}
      <header className="hero">
        <div className="hero-inner">
          <div className="hero-pill">
            Works with ChatGPT, Claude, and Gemini
          </div>
          <h1 className="hero-h1">
            Stop repeating yourself to your AI.
          </h1>
          <p className="hero-sub">
            Tallei is a shared notebook for your AI assistants. 
            Tell it about your projects, your taste, and your preferences once. 
            It makes sure every AI tool you use remembers it forever.
          </p>
          <div className="hero-actions">
            <Link href="/login" className="landing-btn landing-btn-base">
              Try it for free
              <ArrowRight size={16} />
            </Link>
            <p className="hero-guarantee">Takes 2 minutes. No credit card required.</p>
          </div>
        </div>
      </header>

      {/* ═════════════════════════════════════════════════════
          VISUAL / UI MOCKUP — Honest, solid, no glowing orbs
      ═════════════════════════════════════════════════════ */}
      <section className="demo-visual">
        <div className="demo-visual-inner">
          <div className="solid-card hero-mockup">
            <div className="mockup-header">
              <div className="mockup-dots">
                <span />
                <span />
                <span />
              </div>
              <div className="mockup-title">Tallei Memory Log</div>
            </div>
            <div className="mockup-body">
              <div className="mockup-row">
                <div className="mockup-label">Role</div>
                <div className="mockup-value">Brand Marketing Manager</div>
              </div>
              <div className="mockup-row">
                <div className="mockup-label">Current Project</div>
                <div className="mockup-value">Q3 "Summer Unplugged" Campaign Launch</div>
              </div>
              <div className="mockup-row">
                <div className="mockup-label">Preferences</div>
                <div className="mockup-value">
                  - Keep the tone witty but approachable
                  <br />
                  - Format ideas with clear, scannable bullet points
                  <br />
                  - Avoid corporate jargon like "synergize" or "leverage"
                </div>
              </div>
            </div>
            <div className="mockup-footer">
              <Check size={14} className="text-purple" />
              <span>Synced to Claude & ChatGPT</span>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FEATURES — Honest, simple narrative
      ═════════════════════════════════════════════════════ */}
      <section className="features-section">
        <div className="features-inner">
          <h2 className="section-h2">Why we built this</h2>
          
          <div className="story-grid">
            <div className="story-card">
              <div className="story-num">01</div>
              <h3 className="story-h3">The Blank Canvas Problem</h3>
              <p className="story-p">
                Every time you open an AI chat, you start from zero. You have to spend 
                the first three prompts explaining who you are, what you're working on, 
                and how you like things done. It's exhausting.
              </p>
            </div>
            
            <div className="story-card">
              <div className="story-num">02</div>
              <h3 className="story-h3">The Multi-Tool Chaos</h3>
              <p className="story-p">
                You probably use Claude for coding, ChatGPT for brainstorming, and Gemini 
                for research. If you tell Claude something important, ChatGPT remains 
                completely clueless. Your workflow is fragmented.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">03</div>
              <h3 className="story-h3">The Tallei Fix</h3>
              <p className="story-p">
                Tallei acts as a central brain. You connect it to your tools once. 
                From then on, it silently provides context to your AI behind the scenes. 
                When you say "update my website", it actually knows what website you mean.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FAQ / DETAILS
      ═════════════════════════════════════════════════════ */}
      <section className="faq-section">
        <div className="faq-inner">
          <h2 className="section-h2 text-center">The details</h2>
          <div className="faq-grid">
            <div className="solid-card detail-card">
              <h4 className="detail-h4">Is it secure?</h4>
              <p className="detail-p">
                Yes. Your memories are encrypted. We don't read them, and we definitely 
                don't train models on them. It's your private data.
              </p>
            </div>
            <div className="solid-card detail-card">
              <h4 className="detail-h4">How does it connect?</h4>
              <p className="detail-p">
                We use the open MCP protocol for desktop apps (like Claude Desktop) and 
                secure API keys for web environments. Setup takes minutes.
              </p>
            </div>
            <div className="solid-card detail-card">
              <h4 className="detail-h4">Is there a limit?</h4>
              <p className="detail-p">
                No. Save as many facts, preferences, and details as you need. Tallei 
                automatically retrieves only what's relevant to your current conversation.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          CTA
      ═════════════════════════════════════════════════════ */}
      <section className="cta-section">
        <div className="cta-inner">
          <div className="solid-card cta-card">
            <h2 className="section-h2 text-center mt-0">Ready to save your breath?</h2>
            <p className="cta-sub">
              Join the people who stopped copy-pasting their context into every new chat.
            </p>
            <Link href="/login" className="landing-btn landing-btn-large">
              Start using Tallei
            </Link>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FOOTER
      ═════════════════════════════════════════════════════ */}
      <footer className="footer-section">
        <div className="footer-inner">
          <div className="footer-brand">tallei</div>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <a href="mailto:hello@tallei.com">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

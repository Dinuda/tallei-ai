"use client";

import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

/* ─── Component ─────────────────────────────────────────────── */

export function HomeContent() {
  return (
    <div className="landing-root">
      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              "name": "Tallei",
              "url": "https://tallei.com",
              "description": "Persistent memory sync across ChatGPT, Claude, and Gemini",
              "potentialAction": {
                "@type": "SearchAction",
                "target": {
                  "@type": "EntryPoint",
                  "urlTemplate": "https://tallei.com/?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            },
            {
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": "Tallei",
              "applicationCategory": "ProductivityApplication",
              "operatingSystem": "Web",
              "description":
                "Tallei is a shared memory layer for AI assistants. It syncs persistent context across ChatGPT, Claude, and Gemini so you never have to repeat yourself.",
              "url": "https://tallei.com",
              "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "USD",
                "description": "Free tier available",
              },
              "featureList": [
                "Sync memory across ChatGPT, Claude, and Gemini",
                "MCP protocol support for Claude Desktop",
                "Encrypted private memory storage",
                "Unlimited memory entries",
                "Automatic context retrieval",
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "FAQPage",
              "mainEntity": [
                {
                  "@type": "Question",
                  "name": "Is it secure?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "Yes. Your memories are encrypted. We don't read them, and we definitely don't train models on them. It's your private data.",
                  },
                },
                {
                  "@type": "Question",
                  "name": "How does it connect?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "We use the open MCP protocol for desktop apps (like Claude Desktop) and secure API keys for web environments. Setup takes minutes.",
                  },
                },
                {
                  "@type": "Question",
                  "name": "Is there a limit?",
                  "acceptedAnswer": {
                    "@type": "Answer",
                    "text":
                      "No. Save as many facts, preferences, and details as you need. Tallei automatically retrieves only what's relevant to your current conversation.",
                  },
                },
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Tallei",
              "url": "https://tallei.com",
              "logo": "https://tallei.com/tallei.svg",
              "contactPoint": {
                "@type": "ContactPoint",
                "email": "hello@tallei.com",
                "contactType": "customer support",
              },
              "sameAs": [],
            },
          ]),
        }}
      />

      {/* ═════════════════════════════════════════════════════
          HERO — Grounded, straightforward, human
      ═════════════════════════════════════════════════════ */}
      <header className="hero">
        <div className="hero-inner">
          <div className="hero-pill">
            Sync memory between ChatGPT and Claude
          </div>
          <h1 className="hero-h1">
            Make ChatGPT and Claude actually talk to each other.
          </h1>
          <p className="hero-sub">
            Tallei gives your AI tools a shared memory. Teach ChatGPT how you like things, and Claude automatically knows. Stop repeating yourself.
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
      <section className="demo-visual" aria-label="Tallei memory sync preview">
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
              <div className="mockup-row" style={{ alignItems: 'center' }}>
                <div className="mockup-label" style={{ width: '60px', display: 'flex', alignItems: 'center' }}>
                  <img src="/chatgpt.svg" alt="ChatGPT" width={28} height={28} />
                </div>
                <div className="mockup-value">"Always keep my emails short, punchy, and use bullet points."</div>
              </div>
              <div className="mockup-row" style={{ alignItems: 'center' }}>
                <div className="mockup-label" style={{ width: '60px', display: 'flex', alignItems: 'center' }}>
                  <img src="/claude.svg" alt="Claude" width={28} height={28} />
                </div>
                <div className="mockup-value">"Draft a project update for the team."</div>
              </div>
              <div className="mockup-row" style={{ alignItems: 'center' }}>
                <div className="mockup-label" style={{ width: '60px', display: 'flex', alignItems: 'center', position: 'relative' }}>
                  <img src="/chatgpt.svg" alt="ChatGPT" width={28} height={28} style={{ position: 'relative', zIndex: 1 }} />
                  <img src="/claude.svg" alt="Claude" width={28} height={28} style={{ position: 'absolute', left: '16px', zIndex: 2, borderRadius: '50%', border: '2px solid #ffffff' }} />
                </div>
                <div className="mockup-value">
                  Claude automatically writes a concise, bulleted email without you having to remind it how you sound.
                </div>
              </div>
            </div>
            <div className="mockup-footer">
              <Check size={14} className="text-purple" />
              <span>Synced instantly</span>
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
              <h3 className="story-h3">The blank slate sucks</h3>
              <p className="story-p">
                Every time you switch from ChatGPT to Claude, it's like meeting someone for the first time. You have to explain your business, your tone of voice, and your rules all over again. It's exhausting.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">02</div>
              <h3 className="story-h3">Stop copy-pasting</h3>
              <p className="story-p">
                Right now, you're acting as the messenger between two supercomputers. Copying custom instructions from one chat to paste into another is busywork you shouldn't be doing.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">03</div>
              <h3 className="story-h3">Teach one, both learn</h3>
              <p className="story-p">
                Tallei sits quietly in the background. If you tell ChatGPT how you prefer your weekly reports formatted, Claude will automatically know it for your next project. It's just one continuous memory.
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
          <ul className="faq-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">Is it secure?</h3>
              <p className="detail-p">
                Yes. Your memories are encrypted. We don't read them, and we definitely
                don't train models on them. It's your private data.
              </p>
            </li>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">How does it connect?</h3>
              <p className="detail-p">
                We use the open MCP protocol for desktop apps (like Claude Desktop) and
                secure API keys for web environments. Setup takes minutes.
              </p>
            </li>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">Is there a limit?</h3>
              <p className="detail-p">
                No. Save as many facts, preferences, and details as you need. Tallei
                automatically retrieves only what's relevant to your current conversation.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          CTA
      ═════════════════════════════════════════════════════ */}
      <section className="cta-section">
        <div className="cta-inner">
          <div className="solid-card cta-card">
            <h2 className="section-h2 text-center mt-0">Stop repeating yourself.</h2>
            <p className="cta-sub">
              Give your AI tools a shared memory, and stop acting as the middleman.
            </p>
            <Link href="/login" className="landing-btn landing-btn-large">
              Start syncing your AI
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

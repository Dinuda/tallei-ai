import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

const PRICING_PLANS = [
  {
    name: "Free",
    price: "Free",
    description: "For trying Tallei and syncing your first memories.",
    features: ["50 saves/month", "200 recalls/month", "All 3 AI platforms"],
    href: "/login",
    cta: "Start free",
    featured: false,
  },
  {
    name: "Pro",
    price: "$9",
    description: "For daily workflows where memory should just work.",
    features: ["Unlimited saves", "Unlimited recalls", "All 3 AI platforms", "Graph insights"],
    href: "/login?plan=pro",
    cta: "Choose Pro",
    featured: true,
  },
  {
    name: "Power",
    price: "$19",
    description: "For teams and advanced automations with API access.",
    features: ["Everything in Pro", "API access", "Memory export", "Priority support"],
    href: "/login?plan=power",
    cta: "Choose Power",
    featured: false,
  },
] as const;

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
          PRICING
      ═════════════════════════════════════════════════════ */}
      <section
        id="pricing"
        style={{
          padding: "6rem 0",
          background: "#fdfbf7",
          borderTop: "2px solid #e5e0d8",
        }}
      >
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 2rem" }}>
          <h2 className="section-h2 text-center">Pricing</h2>
          <p
            className="text-center"
            style={{
              maxWidth: 640,
              margin: "-1rem auto 2.5rem",
              color: "#4c4643",
              fontSize: "1.05rem",
              lineHeight: 1.6,
            }}
          >
            Built from the same plans you see in billing. Start free, then upgrade when you need more.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "1.25rem",
            }}
          >
            {PRICING_PLANS.map((plan) => (
              <article
                key={plan.name}
                className="solid-card"
                style={{
                  padding: "2rem 1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                  ...(plan.featured
                    ? { borderColor: "#5b21b6", boxShadow: "6px 6px 0px #e1d4fc" }
                    : {}),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                  <h3 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0, color: "#1a1816" }}>{plan.name}</h3>
                  {plan.featured && (
                    <span
                      style={{
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "#5b21b6",
                        border: "1px solid #5b21b6",
                        background: "#f6f0ff",
                        borderRadius: 999,
                        padding: "0.2rem 0.55rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Most popular
                    </span>
                  )}
                </div>

                <p style={{ margin: 0, fontSize: "2rem", fontWeight: 700, color: "#1a1816", lineHeight: 1.1 }}>
                  {plan.price}
                  {plan.price !== "Free" && (
                    <span style={{ fontSize: "0.95rem", fontWeight: 500, color: "#8c827a", marginLeft: "0.2rem" }}>
                      /mo
                    </span>
                  )}
                </p>
                <p style={{ margin: 0, fontSize: "0.98rem", color: "#4c4643", lineHeight: 1.5 }}>{plan.description}</p>

                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", color: "#3d3733", fontSize: "0.92rem", lineHeight: 1.45 }}
                    >
                      <Check size={14} style={{ color: "#5b21b6", marginTop: "0.12rem", flexShrink: 0 }} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.href}
                  style={{
                    marginTop: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.45rem",
                    padding: "0.7rem 1rem",
                    border: `2px solid ${plan.featured ? "#5b21b6" : "#1a1816"}`,
                    background: plan.featured ? "#7c3aed" : "#ffffff",
                    color: plan.featured ? "#ffffff" : "#1a1816",
                    textDecoration: "none",
                    fontWeight: 600,
                    fontSize: "0.92rem",
                    boxShadow: plan.featured ? "3px 3px 0px #e1d4fc" : "3px 3px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  {plan.cta}
                  <ArrowRight size={14} />
                </Link>
              </article>
            ))}
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
          <div className="footer-brand">
            <img src="/tallei.svg" alt="Tallei logo" width={24} height={24} />
          </div>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href="mailto:hello@tallei.com">Contact</a>
            <a href="https://github.com/Dinuda/tallei-ai" target="_blank" rel="noopener noreferrer" className="footer-link-open-source">Open Source</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

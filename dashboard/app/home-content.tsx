import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { IntegrationsSection } from "./components/integrations-section";
import { PerformanceSection } from "./components/performance-section";



const PRICING_PLANS = [
  {
    key: "free" as const,
    name: "Free",
    price: "$0",
    period: "",
    description: "Get started with basic memory features",
    features: ["50 saves/month", "200 recalls/month", "All 3 AI platforms"],
    href: "/login",
    cta: "Get Tallei",
    featured: false,
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: "$9",
    period: "/mo",
    description: "For developers building with AI memory",
    features: ["5,000 saves/month included", "100,000 recalls/month included", "All 3 AI platforms", "Link memories to PDFs"],
    href: "/login?plan=pro",
    cta: "Get Tallei Pro",
    featured: true,
  },
  {
    key: "power" as const,
    name: "Power",
    price: "$19",
    period: "/mo",
    description: "For teams and production workloads",
    features: ["25,000 saves/month included", "500,000 recalls/month included", "API access + export", "Priority support"],
    href: "/login?plan=power",
    cta: "Get Tallei Power",
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
                "High-volume memory allowances",
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
                      "Tallei plans include high monthly allowances designed for normal daily and team workflows, with fair-use protections in place.",
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
                <div className="mockup-value">&ldquo;Always keep my emails short, punchy, and use bullet points.&rdquo;</div>
              </div>
              <div className="mockup-row" style={{ alignItems: 'center' }}>
                <div className="mockup-label" style={{ width: '60px', display: 'flex', alignItems: 'center' }}>
                  <img src="/claude.svg" alt="Claude" width={28} height={28} />
                </div>
                <div className="mockup-value">&ldquo;Draft a project update for the team.&rdquo;</div>
              </div>
              <div className="mockup-row" style={{ alignItems: 'center' }}>
                <div className="mockup-label" style={{ width: '60px', display: 'flex', alignItems: 'center', position: 'relative' }}>
                  <img src="/chatgpt.svg" alt="ChatGPT" width={28} height={28} style={{ position: 'relative', zIndex: 1 }} />
                  <img src="/claude.svg" alt="Claude" width={28} height={28} style={{ position: 'absolute', left: '16px', zIndex: 2, borderRadius: '50%', border: '2px solid #ffffff' }} />
                </div>
                <div className="mockup-value">
                  Claude automatically writes a concise, bulleted email without you having to remind it how you sound.
           </div>
           <p style={{ fontSize: "0.8rem", color: "#8c827a", marginTop: "1.5rem", textAlign: "center" }}>
             * All plans subject to fair usage limits. See our <Link href="/terms" style={{ color: "#5b21b6", textDecoration: "underline" }}>terms of service</Link> for details.
           </p>
         </div>
            </div>
            <div className="mockup-footer">
              <Check size={14} className="text-purple" />
              <span>Synced instantly</span>
            </div>
          </div>
        </div>
      </section>

      <IntegrationsSection />
      <PerformanceSection />

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
                Every time you switch from ChatGPT to Claude, it&apos;s like meeting someone for the first time. You have to explain your business, your tone of voice, and your rules all over again. It&apos;s exhausting.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">02</div>
              <h3 className="story-h3">Stop copy-pasting</h3>
              <p className="story-p">
                Right now, you&apos;re acting as the messenger between two supercomputers. Copying custom instructions from one chat to paste into another is busywork you shouldn&apos;t be doing.
              </p>
            </div>

            <div className="story-card">
              <div className="story-num">03</div>
              <h3 className="story-h3">Teach one, both learn</h3>
              <p className="story-p">
                Tallei sits quietly in the background. If you tell ChatGPT how you prefer your weekly reports formatted, Claude will automatically know it for your next project. It&apos;s just one continuous memory.
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
          padding: "5rem 0 6rem",
          background: "#fdfbf7",
          borderTop: "2px solid #e5e0d8",
        }}
      >
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 1.5rem" }}>
          <h2
            style={{
              fontSize: "2rem",
              fontWeight: 700,
              textAlign: "center",
              color: "#0f172a",
              marginBottom: "0.75rem",
            }}
          >
            Simple, transparent pricing
          </h2>
          <p
            style={{
              maxWidth: 500,
              margin: "0 auto 2.5rem",
              color: "#64748b",
              fontSize: "1rem",
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            Start free, upgrade when you need more. All paid plans include a 14-day free trial.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "1rem",
            }}
          >
            {PRICING_PLANS.map((plan) => (
              <article
                key={plan.key}
                style={{
                  background: "#ffffff",
                  border: plan.featured ? "2px solid #5b21b6" : "2px solid #e5e0d8",
                  borderRadius: 4,
                  padding: "1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                  boxShadow: plan.featured ? "4px 4px 0px #e1d4fc" : "4px 4px 0px #e5e0d8",
                }}
              >
                {/* Plan Badge Row */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: plan.featured ? "#5b21b6" : "#8c827a",
                    }}
                  >
                    {plan.name}
                  </span>
                  {plan.featured && (
                    <span
                      style={{
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "#5b21b6",
                        border: "2px solid #5b21b6",
                        background: "#fdfbf7",
                        borderRadius: 999,
                        padding: "0.15rem 0.5rem",
                      }}
                    >
                      Most popular
                    </span>
                  )}
                </div>

                {/* Price */}
                <div>
                  <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>
                    {plan.price}
                    {plan.period && (
                      <span style={{ fontSize: "1rem", fontWeight: 500, color: "#8c827a", marginLeft: "0.15rem" }}>
                        {plan.period}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "#4c4643", lineHeight: 1.5 }}>
                    {plan.description}
                  </p>
                </div>

                {/* Features */}
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                    style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", color: "#334155", fontSize: "0.875rem", lineHeight: 1.5 }}
                  >
                      <Check size={16} style={{ color: "#7c3aed", flexShrink: 0, marginTop: "0.1rem" }} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <div style={{ marginTop: "auto", paddingTop: "0.5rem" }}>
                  <Link
                    href={plan.href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "0.4rem",
                      padding: "0.75rem 1rem",
                      borderRadius: 4,
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      textDecoration: "none",
                      transition: "all 0.15s ease",
                      background: plan.featured ? "#7c3aed" : "#ffffff",
                      color: plan.featured ? "#ffffff" : "#0f172a",
                      border: plan.featured ? "2px solid #5b21b6" : "2px solid #e5e0d8",
                      boxShadow: plan.featured ? "3px 3px 0px #e1d4fc" : "3px 3px 0px #e5e0d8",
                    }}
                  >
                    {plan.cta}
                    <ArrowRight size={14} />
                  </Link>
                  {!plan.featured && plan.key !== "free" && (
                    <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#94a3b8", textAlign: "center" }}>
                      14-day free trial
                    </p>
                  )}
                  {plan.featured && (
                    <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#94a3b8", textAlign: "center" }}>
                      14-day free trial
                    </p>
                  )}
                </div>
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
                Yes. Your memories are encrypted. We don&apos;t read them, and we definitely
                don&apos;t train models on them. It&apos;s your private data.
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
                automatically retrieves only what&apos;s relevant to your current conversation.
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

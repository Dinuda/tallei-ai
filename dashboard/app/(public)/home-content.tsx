import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { HeroSection } from "../components/landing/hero-section";
import { ShowcaseSection } from "../components/landing/showcase-section";
import { MemorySection } from "../components/landing/memory-section";
import { IntegrationsSection } from "../components/integrations-section";
import { PerformanceSection } from "../components/performance-section";
import "../components/landing/landing.css";

const PRICING_PLANS = [
  {
    key: "free" as const,
    name: "Free",
    price: "$0",
    period: "",
    description: "Get started with cross-AI memory",
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
    description: "For people using memory every day",
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

const JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Tallei",
    url: "https://tallei.com",
    description: "Intent-driven memory across ChatGPT, Claude, and Gemini",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Tallei",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "Web",
    description:
      "Tallei syncs memory across ChatGPT, Claude, and Gemini so your context follows you everywhere.",
    url: "https://tallei.com",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free tier available",
    },
    featureList: [
      "Sync memory across ChatGPT, Claude, and Gemini",
      "MCP protocol support for Claude Desktop",
      "Automatic context retrieval",
      "Vector search recall",
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Is it secure?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Your memories are encrypted. We don't read them, and we don't train models on them.",
        },
      },
      {
        "@type": "Question",
        name: "How does it connect?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "We use the open MCP protocol for desktop apps and secure API keys for web environments. Setup takes minutes.",
        },
      },
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Tallei",
    url: "https://tallei.com",
    logo: "https://tallei.com/tallei.svg",
    contactPoint: {
      "@type": "ContactPoint",
      email: "hello@tallei.com",
      contactType: "customer support",
    },
    sameAs: [],
  },
];

export function HomeContent() {
  return (
    <div className="landing-v2">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <HeroSection />
      <ShowcaseSection />
      <MemorySection />

      <section id="integrations" className="landing-proof">
        <div className="landing-section-inner">
          <div className="landing-section-header">
            <h2 className="landing-section-title">Memory in every conversation</h2>
            <p className="landing-section-sub">
              Watch context follow you across tools — no copy-paste, no re-explaining.
            </p>
          </div>
        </div>
        <IntegrationsSection />
      </section>

      <section id="pricing" className="pricing-section">
        <div className="pricing-inner">
          <h2 className="section-h2 pricing-heading">Simple pricing</h2>
          <p className="pricing-sub">
            Start free. Upgrade when you need more room.
          </p>

          <div className="pricing-grid">
            {PRICING_PLANS.map((plan) => (
              <article
                key={plan.key}
                className={`pricing-card ${plan.featured ? "pricing-card-featured" : ""}`}
              >
                <div className="pricing-plan-row">
                  <span className={`pricing-plan-label ${plan.featured ? "pricing-plan-label-featured" : ""}`}>
                    {plan.name}
                  </span>
                  {plan.featured && <span className="pricing-popular-pill">Most popular</span>}
                </div>

                <div className="pricing-price-wrap">
                  <div className="pricing-price">
                    {plan.price}
                    {plan.period && <span className="pricing-period">{plan.period}</span>}
                  </div>
                  <p className="pricing-description">{plan.description}</p>
                </div>

                <ul className="pricing-features">
                  {plan.features.map((feature) => (
                    <li key={feature} className="pricing-feature-item">
                      <Check size={16} className="pricing-feature-check" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="pricing-cta-wrap">
                  <Link
                    href={plan.href}
                    className={`pricing-cta ${plan.featured ? "pricing-cta-featured" : ""}`}
                  >
                    {plan.cta}
                    <ArrowRight size={14} />
                  </Link>
                  {plan.key !== "free" && <p className="pricing-trial">14-day free trial</p>}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <PerformanceSection />

      <section className="faq-section">
        <div className="faq-inner">
          <h2 className="section-h2">Questions</h2>
          <ul className="faq-grid">
            <li className="solid-card detail-card">
              <h3 className="detail-h4">Is it secure?</h3>
              <p className="detail-p">
                Yes. Your memories are encrypted. We don&apos;t read them, and we don&apos;t train models on them.
              </p>
            </li>
            <li className="solid-card detail-card">
              <h3 className="detail-h4">How does it connect?</h3>
              <p className="detail-p">
                MCP for desktop apps like Claude. Secure API keys for web. Setup takes a few minutes.
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section className="cta-section">
        <div className="cta-inner">
          <div className="solid-card cta-card">
            <h2 className="section-h2 text-center mt-0">Stop repeating yourself.</h2>
            <p className="cta-sub">
              Connect Tallei once. Let every AI already know how you work.
            </p>
            <Link href="/login" className="landing-btn landing-btn-base landing-cta--lime">
              Get started
            </Link>
          </div>
        </div>
      </section>

      <footer className="footer-section">
        <div className="footer-inner">
          <div className="footer-brand">
            <Image src="/tallei.svg" alt="Tallei logo" width={24} height={24} style={{ width: "auto", height: "auto" }} />
          </div>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href="mailto:hello@tallei.com">Contact</a>
            <a href="https://github.com/Dinuda/tallei-ai" target="_blank" rel="noopener noreferrer" className="footer-link-open-source">
              Open Source
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

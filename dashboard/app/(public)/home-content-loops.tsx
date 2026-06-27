import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  FileText,
  GitBranch,
  Mail,
  MessageSquare,
  Sun,
  TrendingUp,
  Users,
} from "lucide-react";
import { IntegrationsSection } from "../components/integrations-section";
import { LoopsApprovalCard } from "./loops-approval-card";
import { LoopsScrollReveal } from "./loops-scroll-reveal";

const PRICING_PLANS = [
  {
    key: "free" as const,
    name: "Free",
    price: "$0",
    period: "",
    description: "Get started with loops and memory",
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
    description: "For people running loops every day",
    features: [
      "5,000 saves/month included",
      "100,000 recalls/month included",
      "All 3 AI platforms",
      "Link memories to PDFs",
    ],
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
    features: [
      "25,000 saves/month included",
      "500,000 recalls/month included",
      "API access + export",
      "Priority support",
    ],
    href: "/login?plan=power",
    cta: "Get Tallei Power",
    featured: false,
  },
] as const;

const PROBLEM_EXAMPLES = [
  "Weekly newsletters",
  "Investor updates",
  "Product changelogs",
  "Meeting follow-ups",
  "Customer replies",
  "Product summaries",
  "Launch posts",
  "Founder briefings",
] as const;

const HOW_IT_WORKS_STEPS = [
  {
    num: "01",
    title: "Capture",
    body: "Tallei connects to your AI work, docs, and tools.",
    embedIntegrations: true,
  },
  {
    num: "02",
    title: "Remember",
    body: "It stores useful company context, preferences, decisions, and outputs.",
  },
  {
    num: "03",
    title: "Clean",
    body: "Tallei cleans and merges memory so it stays useful.",
  },
  {
    num: "04",
    title: "Detect loops",
    body: "It finds repeated work patterns across your activity.",
  },
  {
    num: "05",
    title: "Automate with approval",
    body: "Tallei prepares recurring drafts or actions and asks before sending, publishing, or changing anything.",
  },
] as const;

const LOOP_CARDS = [
  {
    icon: Mail,
    name: "Company newsletter",
    outcome: "Turn product progress into weekly customer updates.",
  },
  {
    icon: TrendingUp,
    name: "Investor update",
    outcome: "Prepare monthly investor emails from company memory and recent work.",
  },
  {
    icon: GitBranch,
    name: "Changelog",
    outcome: "Turn GitHub activity and product notes into release updates.",
  },
  {
    icon: Users,
    name: "Meeting follow-up",
    outcome: "Summarize calls and draft follow-up emails.",
  },
  {
    icon: MessageSquare,
    name: "Customer feedback digest",
    outcome: "Cluster feedback into product insights.",
  },
  {
    icon: Sun,
    name: "Founder briefing",
    outcome: "Get a daily or weekly summary of what changed, what is blocked, and what needs attention.",
  },
] as const;

const COMPARISON_ROWS = [
  {
    label: "Normal AI chat",
    description: "Helps once, then forgets.",
    highlight: false,
  },
  {
    label: "Memory tools",
    description: "Store context, but do not turn repeated work into action.",
    highlight: false,
  },
  {
    label: "Automation builders",
    description: "Require users to manually build workflows.",
    highlight: false,
  },
  {
    label: "Generic AI agents",
    description: "Do tasks, but often lack long-term memory and approval structure.",
    highlight: false,
  },
  {
    label: "Tallei",
    description:
      "Remembers scattered AI work, detects repeated loops, and turns them into approved recurring workflows.",
    highlight: true,
  },
] as const;

const APPROVAL_EXAMPLES = [
  { action: "Approve newsletter draft", detail: "Review before sending" },
  { action: "Create Gmail draft", detail: "Edit workflow" },
  { action: "Ignore suggestion", detail: "Pause loop" },
] as const;

const AUDIENCE = [
  "Technical founders",
  "Solo founders",
  "Startup operators",
  "Indie hackers",
  "Product managers",
  "Engineering leads",
  "Growth marketers",
  "Agencies",
  "Consultants",
  "Newsletter operators",
  "Power users of ChatGPT, Claude, Codex, and Cursor",
] as const;

const JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Tallei",
    url: "https://tallei.com",
    description:
      "Tallei remembers scattered AI work, discovers repeated loops, and turns them into approved recurring workflows.",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Tallei",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "Web",
    description:
      "Tallei remembers your scattered work across AI tools, detects repeated patterns, and turns them into approved recurring workflows called loops.",
    url: "https://tallei.com",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free tier available",
    },
    featureList: [
      "Loop detection from repeated AI work",
      "Cross-tool memory capture",
      "Approval-first automation",
      "Weekly newsletters and investor updates",
      "Meeting follow-ups and changelogs",
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is a loop?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "A loop is repeated AI work that Tallei detects from your activity — like weekly newsletters or investor updates — and offers to automate with your approval.",
        },
      },
      {
        "@type": "Question",
        name: "Does Tallei send emails without approval?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "No. Tallei prepares drafts and suggestions. Risky actions like sending emails, publishing posts, or updating external systems require your explicit approval.",
        },
      },
      {
        "@type": "Question",
        name: "How is Tallei different from memory tools?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Memory tools store context. Tallei goes further — it detects when you repeat similar work and asks if you want to turn that pattern into an approved recurring workflow.",
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

export function HomeContentLoops() {
  return (
    <div className="loops-home">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="loops-hero">
        <div className="loops-section-inner loops-hero-grid">
          <div className="loops-hero-copy">
            <p className="loops-mono loops-eyebrow">Loops by Tallei</p>
            <h1 className="loops-hero-title">
              Your AI work has patterns. Tallei turns them into loops.
            </h1>
            <p className="loops-hero-sub">
              Tallei remembers your scattered work across ChatGPT, Claude, Codex, docs,
              email, and tools. Then it discovers repeated patterns and asks if you want
              to automate them safely.
            </p>
            <div className="loops-hero-actions">
              <Link href="/login" className="loops-btn loops-btn-primary">
                Start building loops
                <ArrowRight size={16} />
              </Link>
              <Link href="/#how-it-works" className="loops-btn loops-btn-secondary">
                See how it works
              </Link>
            </div>
            <div className="loops-hero-stats">
              <div className="loops-stat">
                <span className="loops-stat-value">12+</span>
                <span className="loops-mono loops-stat-label">loop types</span>
              </div>
              <div className="loops-stat-divider" aria-hidden />
              <div className="loops-stat">
                <span className="loops-stat-value">4hrs</span>
                <span className="loops-mono loops-stat-label">saved / week</span>
              </div>
              <div className="loops-stat-divider" aria-hidden />
              <div className="loops-stat">
                <span className="loops-stat-value">100%</span>
                <span className="loops-mono loops-stat-label">approval-first</span>
              </div>
            </div>
          </div>

          <div className="loops-hero-visual">
            <LoopsApprovalCard />
          </div>
        </div>
      </section>

      {/* ── Problem ──────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section loops-section-band">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">The problem</p>
            <h2 className="loops-section-title">AI work is scattered and repetitive.</h2>
            <div className="loops-prose-grid">
              <p>
                People use ChatGPT, Claude, Codex, Cursor, email, docs, GitHub, Notion, and
                Slack to get work done. But the context is spread everywhere. Every time they
                start again, they re-explain the company, the project, the tone, the sources,
                and what happened before.
              </p>
              <div className="loops-callout">
                <p className="loops-callout-label">The hidden problem</p>
                <p className="loops-callout-text">
                  Many AI tasks are not one-off tasks. They are <strong>loops</strong>.
                </p>
              </div>
            </div>
            <ul className="loops-tag-grid">
              {PROBLEM_EXAMPLES.map((item) => (
                <li key={item} className="loops-mono loops-tag">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Solution ─────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section">
          <div className="loops-section-inner loops-solution-grid">
            <div>
              <p className="loops-mono loops-eyebrow">The solution</p>
              <h2 className="loops-section-title">
                Tallei discovers the loops inside your AI work.
              </h2>
              <p className="loops-section-body">
                Tallei remembers useful context from your AI activity, cleans it into
                reliable memory, and groups work into episodes. When similar episodes repeat,
                Tallei suggests a loop.
              </p>
              <p className="loops-section-body loops-section-body--emphasis">
                You do not manually build automations. Tallei notices repeated work and asks
                for permission.
              </p>
            </div>
            <blockquote className="loops-quote-card">
              <p className="loops-quote-text">
                &ldquo;You&apos;ve written 3 similar newsletters recently. Want me to prepare
                one every Friday?&rdquo;
              </p>
              <footer className="loops-mono loops-quote-footer">Loop suggestion · approval required</footer>
            </blockquote>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── How it works ─────────────────────────────────────── */}
      <section id="how-it-works" className="loops-section loops-section-band">
        <div className="loops-section-inner">
          <LoopsScrollReveal>
            <p className="loops-mono loops-eyebrow">How it works</p>
            <h2 className="loops-section-title">From scattered work to approved loops.</h2>
            <p className="loops-section-lead">
              Five steps. Tallei does the noticing — you stay in control of what runs.
            </p>
          </LoopsScrollReveal>

          <ol className="loops-steps">
            {HOW_IT_WORKS_STEPS.map((step) => (
              <li key={step.num} className="loops-step">
                <div className="loops-step-header">
                  <span className="loops-mono loops-step-num">{step.num}</span>
                  <div>
                    <h3 className="loops-step-title">{step.title}</h3>
                    <p className="loops-step-body">{step.body}</p>
                  </div>
                </div>
                {"embedIntegrations" in step && step.embedIntegrations && (
                  <div className="loops-step-integrations">
                    <IntegrationsSection />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Example loop ───────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Example</p>
            <h2 className="loops-section-title">Weekly company newsletter</h2>

            <ol className="loops-example-flow">
              <li>You ask ChatGPT or Claude to write a newsletter.</li>
              <li>Tallei remembers the company context and writing style.</li>
              <li>
                After similar work repeats, Tallei suggests: &ldquo;Want me to prepare this
                every Friday?&rdquo;
              </li>
              <li>You approve.</li>
              <li>Every Friday, Tallei drafts the newsletter using memory and sources.</li>
              <li>You review, edit, approve, or ignore.</li>
            </ol>

            <article className="loops-output-card">
              <header className="loops-output-header">
                <FileText size={18} aria-hidden />
                <h3 className="loops-output-name">Weekly Company Newsletter</h3>
              </header>
              <dl className="loops-output-meta">
                <div className="loops-output-row">
                  <dt className="loops-mono">Runs</dt>
                  <dd>Every Friday</dd>
                </div>
                <div className="loops-output-row">
                  <dt className="loops-mono">Uses</dt>
                  <dd>Company memory, product notes, optional GitHub/Notion updates</dd>
                </div>
                <div className="loops-output-row">
                  <dt className="loops-mono">Output</dt>
                  <dd>Draft newsletter</dd>
                </div>
                <div className="loops-output-row">
                  <dt className="loops-mono">Approval</dt>
                  <dd>Required before sending</dd>
                </div>
              </dl>
            </article>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Loop library ───────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section id="loops" className="loops-section loops-section-band">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Loop library</p>
            <h2 className="loops-section-title">What loops can Tallei create?</h2>
            <p className="loops-section-lead">
              Concrete workflows discovered from how you already work — not templates you
              have to wire up yourself.
            </p>

            <ul className="loops-card-grid">
              {LOOP_CARDS.map((card) => {
                const Icon = card.icon;
                return (
                  <li key={card.name} className="loops-loop-card">
                    <div className="loops-loop-card-icon" aria-hidden>
                      <Icon size={20} strokeWidth={1.75} />
                    </div>
                    <h3 className="loops-loop-card-name">{card.name}</h3>
                    <p className="loops-loop-card-outcome">{card.outcome}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Comparison ─────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Why Tallei</p>
            <h2 className="loops-section-title">Not just memory. Not just agents. Loops.</h2>

            <div className="loops-comparison-wrap">
              <table className="loops-comparison-table">
                <thead>
                  <tr>
                    <th scope="col" className="loops-mono">
                      Category
                    </th>
                    <th scope="col" className="loops-mono">
                      What you get
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON_ROWS.map((row) => (
                    <tr
                      key={row.label}
                      className={row.highlight ? "loops-comparison-row--highlight" : undefined}
                    >
                      <td className="loops-mono loops-comparison-label">{row.label}</td>
                      <td className="loops-mono loops-comparison-desc">{row.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Pricing ────────────────────────────────────────────── */}
      <section id="pricing" className="loops-section loops-pricing-section">
        <div className="loops-section-inner">
          <LoopsScrollReveal>
            <h2 className="loops-section-title loops-text-center">Simple pricing</h2>
            <p className="loops-section-lead loops-text-center">
              Start free. Upgrade when your loops need more room.
            </p>
          </LoopsScrollReveal>

          <div className="loops-pricing-grid">
            {PRICING_PLANS.map((plan) => (
              <article
                key={plan.key}
                className={`loops-pricing-card${plan.featured ? " loops-pricing-card--featured" : ""}`}
              >
                <div className="loops-pricing-plan-row">
                  <span
                    className={`loops-mono loops-pricing-plan-label${plan.featured ? " loops-pricing-plan-label--featured" : ""}`}
                  >
                    {plan.name}
                  </span>
                  {plan.featured && (
                    <span className="loops-mono loops-pricing-popular">Most popular</span>
                  )}
                </div>

                <div className="loops-pricing-price-wrap">
                  <div className="loops-pricing-price">
                    {plan.price}
                    {plan.period && (
                      <span className="loops-pricing-period">{plan.period}</span>
                    )}
                  </div>
                  <p className="loops-pricing-description">{plan.description}</p>
                </div>

                <ul className="loops-pricing-features">
                  {plan.features.map((feature) => (
                    <li key={feature} className="loops-pricing-feature">
                      <Check size={16} className="loops-pricing-check" aria-hidden />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="loops-pricing-cta-wrap">
                  <Link
                    href={plan.href}
                    className={`loops-btn loops-pricing-cta${plan.featured ? " loops-btn-primary" : " loops-btn-secondary"}`}
                  >
                    {plan.cta}
                    <ArrowRight size={14} />
                  </Link>
                  {plan.key !== "free" && (
                    <p className="loops-mono loops-pricing-trial">14-day free trial</p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Trust & approval ───────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section loops-section-band">
          <div className="loops-section-inner loops-trust-grid">
            <div>
              <p className="loops-mono loops-eyebrow">Trust</p>
              <h2 className="loops-section-title">Automation, but never reckless.</h2>
              <p className="loops-section-body">
                Tallei is built around approval. It can draft, prepare, summarize, and
                suggest. Risky actions like sending emails, publishing posts, or updating
                external systems require user approval.
              </p>
              <p className="loops-trust-tagline">
                Tallei prepares the work. <strong>You stay in control.</strong>
              </p>
            </div>

            <ul className="loops-approval-examples">
              {APPROVAL_EXAMPLES.map((item) => (
                <li key={item.action} className="loops-approval-example">
                  <span className="loops-approval-example-action">{item.action}</span>
                  <span className="loops-mono loops-approval-example-detail">{item.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Customer base ──────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Built for</p>
            <h2 className="loops-section-title">AI-native workers.</h2>
            <ul className="loops-audience-grid">
              {AUDIENCE.map((item) => (
                <li key={item} className="loops-mono loops-audience-item">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Final CTA ──────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section loops-final-cta">
          <div className="loops-section-inner loops-final-cta-inner">
            <h2 className="loops-final-cta-title">Find the loops in your AI work.</h2>
            <p className="loops-final-cta-sub">
              Tallei remembers your context, detects repeated work, and helps you automate
              it safely.
            </p>
            <div className="loops-hero-actions loops-final-cta-actions">
              <Link href="/login" className="loops-btn loops-btn-primary">
                Start with Tallei
                <ArrowRight size={16} />
              </Link>
              <Link href="/login" className="loops-btn loops-btn-secondary">
                Join waitlist
              </Link>
            </div>
            <p className="loops-mono loops-final-cta-note">
              Your first loop could be a newsletter, investor update, changelog, or meeting
              follow-up.
            </p>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="loops-footer">
        <div className="loops-footer-inner">
          <div className="loops-footer-brand">
            <Image
              src="/tallei.svg"
              alt="Tallei logo"
              width={24}
              height={24}
              style={{ width: "auto", height: "auto" }}
            />
          </div>
          <div className="loops-footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href="mailto:hello@tallei.com">Contact</a>
            <a
              href="https://github.com/Dinuda/tallei-ai"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Source
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

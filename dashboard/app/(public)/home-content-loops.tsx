import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { AgentTeamCard } from "./agent-team-card";
import { HeroLoopVisual } from "./hero-loop-visual";
import { HowItWorksSteps } from "./how-it-works-steps";
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

const HOW_IT_WORKS_STEPS = [
  {
    num: "01",
    title: "Define the outcome",
    body: "Tell Tallei what should happen on a schedule.",
    detail: "“Send our monthly newsletter every Friday”",
  },
  {
    num: "02",
    title: "Tallei spawns a specialized team",
    body: "Focused agents take the jobs a generalist would muddle.",
    detail: "Market Researcher · Brand Voice Writer · Editor · Deliverer",
  },
  {
    num: "03",
    title: "The Loop runs reliably",
    body: "Agents hand off work automatically. You review final output — or only when exceptions occur.",
  },
] as const;

const EXAMPLE_LOOPS = [
  {
    name: "Newsletter Loop",
    agents: [
      {
        initials: "MR",
        title: "Market Researcher",
        description: "Finds metrics & stories",
      },
      {
        initials: "MW",
        title: "Marketing Writer",
        description: "Drafts in your tone",
      },
      {
        initials: "ED",
        title: "Editor",
        description: "Polishes & formats",
      },
      {
        initials: "SN",
        title: "Sender",
        description: "Delivers + tracks engagement",
      },
    ],
  },
  {
    name: "Investor Update Loop",
    agents: [
      {
        initials: "MA",
        title: "Metrics Analyst",
        description: "Pulls the numbers that matter",
      },
      {
        initials: "ST",
        title: "Storyteller",
        description: "Frames progress and risks",
      },
      {
        initials: "DB",
        title: "Deck Builder",
        description: "Shapes a clear update",
      },
      {
        initials: "DL",
        title: "Deliverer",
        description: "Sends when you approve",
      },
    ],
  },
  {
    name: "Meeting Follow-up Loop",
    agents: [
      {
        initials: "SM",
        title: "Summarizer",
        description: "Captures what was decided",
      },
      {
        initials: "AO",
        title: "Action Item Owner",
        description: "Tracks who owes what",
      },
      {
        initials: "EM",
        title: "Email Drafter",
        description: "Writes the follow-up",
      },
      {
        initials: "CB",
        title: "Calendar Booker",
        description: "Schedules next steps",
      },
    ],
  },
] as const;

const WHY_POINTS = [
  {
    title: "Specialization",
    body: "Each agent is excellent at one job — research, writing, formatting, or delivery.",
  },
  {
    title: "Memory & Context",
    body: "Agents learn your company, tone, and processes so every run starts informed.",
  },
  {
    title: "Control & Safety",
    body: "Human approval, full audit logs, and easy overrides keep you in charge.",
  },
] as const;

const JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Tallei",
    url: "https://tallei.com",
    description:
      "Tallei turns recurring tasks across ChatGPT, Claude, Gmail, Docs, Slack, and Notion into specialized AI Loops powered by focused agents.",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Tallei",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "Web",
    description:
      "Tallei turns recurring work into AI Loops — workflows powered by specialized agents that research, write, format, and deliver with approval-first control.",
    url: "https://tallei.com",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free tier available",
    },
    featureList: [
      "Specialized agent teams for recurring workflows",
      "Newsletter, investor update, and meeting follow-up loops",
      "Cross-tool context across ChatGPT, Claude, Gmail, Docs, Slack, and Notion",
      "Approval-first automation with audit logs",
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is a Loop?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "A Loop is a recurring workflow powered by a specialized team of AI agents — for example a Newsletter Loop with a researcher, writer, editor, and sender — that runs reliably with your approval.",
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
        name: "How is Tallei different from a single AI agent?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Instead of one generalist, Tallei runs a team of focused agents. Each role is excellent at one job, and agents hand off work automatically while you stay in control.",
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
        <div className="loops-section-inner loops-hero-centered">
          <h1 className="loops-hero-title loops-hero-title--centered">
            Your repeated work should run itself.
          </h1>
          <p className="loops-hero-sub loops-hero-sub--centered">
            Tallei turns recurring tasks across ChatGPT, Claude, Gmail, Docs, Slack, and
            Notion into specialized <strong>AI Loops</strong> — workflows powered by focused
            agents that research, write, format, and deliver.
          </p>
          <div className="loops-hero-actions loops-hero-actions--centered">
            <Link href="/login" className="loops-btn loops-btn-primary">
              Start building your first Loop
              <ArrowRight size={16} />
            </Link>
            <Link href="/#how-it-works" className="loops-btn loops-btn-secondary">
              Watch demo (90s)
            </Link>
          </div>
          <p className="loops-mono loops-hero-trust">
            4+ hours saved per week · Approval-first · Used by startup operators
          </p>
          <div className="loops-hero-visual">
            <HeroLoopVisual />
          </div>
        </div>
      </section>

      {/* ── Problem ──────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section loops-section-band">
          <div className="loops-section-inner loops-problem-block">
            <p className="loops-mono loops-eyebrow">The problem</p>
            <h2 className="loops-section-title">
              AI has made creation easy.
              <br />
              Execution is still manual.
            </h2>
            <p className="loops-section-lead">
              You&apos;re repeating the same workflows every week — gathering data, writing
              updates, sending newsletters, following up on meetings. Different parts need
              different skills, and context gets lost every time.
            </p>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── How it works ─────────────────────────────────────── */}
      <section id="how-it-works" className="loops-section">
        <div className="loops-section-inner">
          <LoopsScrollReveal>
            <p className="loops-mono loops-eyebrow">How it works</p>
            <h2 className="loops-section-title">From outcome to a running Loop.</h2>
            <p className="loops-section-lead">
              Three steps. Specialized agents do the hand-offs — you stay in control of what
              ships.
            </p>
          </LoopsScrollReveal>
          <LoopsScrollReveal>
            <HowItWorksSteps steps={HOW_IT_WORKS_STEPS} />
          </LoopsScrollReveal>
        </div>
      </section>

      {/* ── Specialized team / example loops ─────────────────── */}
      <LoopsScrollReveal>
        <section id="loops" className="loops-section loops-section-band">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Build your specialized team</p>
            <h2 className="loops-section-title">
              Not one generalist. A team of focused agents.
            </h2>
            <p className="loops-section-lead">
              Each Loop shows the roles that research, write, polish, and deliver — so
              recurring work stays sharp instead of generic.
            </p>

            <div className="loops-agent-team-grid">
              {EXAMPLE_LOOPS.map((loop) => (
                <AgentTeamCard key={loop.name} name={loop.name} agents={loop.agents} />
              ))}
            </div>
          </div>
        </section>
      </LoopsScrollReveal>

      {/* ── Why operators choose Tallei ───────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section">
          <div className="loops-section-inner">
            <p className="loops-mono loops-eyebrow">Why operators choose Tallei</p>
            <h2 className="loops-section-title">Built for people who run the work.</h2>
            <ul className="loops-why-grid">
              {WHY_POINTS.map((point) => (
                <li key={point.title} className="loops-why-card">
                  <h3 className="loops-why-title">{point.title}</h3>
                  <p className="loops-why-body">{point.body}</p>
                </li>
              ))}
            </ul>
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

      {/* ── Final CTA ──────────────────────────────────────────── */}
      <LoopsScrollReveal>
        <section className="loops-section loops-final-cta">
          <div className="loops-section-inner loops-final-cta-inner">
            <h2 className="loops-final-cta-title">Stop doing the same work twice.</h2>
            <p className="loops-final-cta-sub">
              Build your first specialized Loop in minutes.
            </p>
            <div className="loops-hero-actions loops-final-cta-actions">
              <Link href="/login" className="loops-btn loops-btn-primary">
                Get started free
                <ArrowRight size={16} />
              </Link>
            </div>
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

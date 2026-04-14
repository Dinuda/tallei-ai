"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  ArrowRight,
  Zap,
  Shield,
  Globe,
  Brain,
  Sparkles,
  ChevronRight,
  MessageSquare,
  Database,
  Cpu,
} from "lucide-react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { TextPlugin } from "gsap/TextPlugin";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, TextPlugin);
}

/* ─── Data ─────────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: Brain,
    title: "Persistent Memory",
    desc: "Every conversation builds context. Your AI remembers preferences, projects, and goals across sessions.",
    color: "#7eb71b",
  },
  {
    icon: Globe,
    title: "Cross-Platform Sync",
    desc: "Claude, ChatGPT, Gemini — all share the same memory. Switch tools without losing context.",
    color: "#f97316",
  },
  {
    icon: Zap,
    title: "< 10ms Latency",
    desc: "Context injection so fast it's invisible. Zero delay between your question and a personalized answer.",
    color: "#3b82f6",
  },
  {
    icon: Shield,
    title: "End-to-End Private",
    desc: "Your memories are encrypted, never shared, and never used for training. You own your data.",
    color: "#8b5cf6",
  },
  {
    icon: Database,
    title: "Unlimited Storage",
    desc: "No caps on memories. Your entire history — preferences, decisions, context — always available.",
    color: "#ec4899",
  },
  {
    icon: Cpu,
    title: "Open MCP Protocol",
    desc: "Built on the Model Context Protocol standard. No vendor lock-in, full interoperability.",
    color: "#14b8a6",
  },
];

const STEPS = [
  {
    num: "01",
    title: "Talk naturally",
    desc: "Chat with any AI assistant. Mention your work, preferences, or goals — Tallei listens in the background.",
    visual: "💬",
  },
  {
    num: "02",
    title: "Auto-capture",
    desc: "Important details are instantly extracted and saved to your encrypted memory store. Zero manual effort.",
    visual: "🧠",
    highlight: true,
  },
  {
    num: "03",
    title: "Instant recall",
    desc: "Switch to any AI platform and it already knows your full context. Every assistant is always caught up.",
    visual: "✨",
  },
];

const TESTIMONIALS = [
  {
    name: "Sarah Chen",
    role: "Staff Engineer, Stripe",
    initials: "SC",
    quote: "I switch between Claude and GPT-4 constantly. Tallei means I never re-explain my codebase or conventions.",
    accent: "#f97316",
  },
  {
    name: "Marcus Reid",
    role: "Indie Maker",
    initials: "MR",
    quote: "My AI finally feels like a real collaborator. It knows my product, my stack, my goals. Game changer.",
    accent: "#10a37f",
  },
  {
    name: "Priya Nair",
    role: "Product Lead, Linear",
    initials: "PN",
    quote: "Gemini for research, Claude for writing — both equally well-briefed. The sync is seamless.",
    accent: "#8b5cf6",
  },
];

const STATS = [
  { value: "10K+", label: "Memories saved" },
  { value: "3", label: "AI platforms" },
  { value: "<10ms", label: "Avg latency" },
  { value: "100%", label: "Private" },
];

/* ─── Component ─────────────────────────────────────────────── */

export default function Home() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    const ctx = gsap.context(() => {
      /* ── Hero entrance ── */
      const heroTl = gsap.timeline({ defaults: { ease: "power3.out" } });
      heroTl
        .from(".hero-pill", { y: 20, opacity: 0, duration: 0.6 })
        .from(".hero-title-line", {
          y: 60,
          opacity: 0,
          stagger: 0.12,
          duration: 0.8,
        }, "-=0.3")
        .from(".hero-sub", { y: 20, opacity: 0, duration: 0.6 }, "-=0.3")
        .from(".hero-cta", { y: 20, opacity: 0, stagger: 0.1, duration: 0.5 }, "-=0.2")
        .from(".hero-stat", { y: 20, opacity: 0, stagger: 0.08, duration: 0.5 }, "-=0.2")
        .from(".hero-visual", { y: 40, opacity: 0, scale: 0.96, duration: 1.0 }, "-=0.6");

      /* ── Hero floating orbs ── */
      gsap.utils.toArray<HTMLElement>(".hero-orb").forEach((orb) => {
        gsap.to(orb, {
          y: `+=${15 + Math.random() * 20}`,
          x: `+=${(Math.random() - 0.5) * 15}`,
          duration: 3 + Math.random() * 3,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          delay: Math.random() * 2,
        });
      });

      /* ── Marquee entrance ── */
      gsap.from(".marquee-section", {
        opacity: 0,
        duration: 0.6,
        scrollTrigger: { trigger: ".marquee-section", start: "top 92%" },
      });

      /* ── Features stagger ── */
      gsap.from(".feature-card", {
        y: 50,
        opacity: 0,
        stagger: 0.1,
        duration: 0.7,
        ease: "power3.out",
        scrollTrigger: { trigger: ".features-grid", start: "top 80%" },
      });

      /* ── Feature card glow ── */
      document.querySelectorAll<HTMLElement>(".feature-card").forEach(card => {
        const onMove = (e: MouseEvent) => {
          const rect = card.getBoundingClientRect();
          card.style.setProperty("--gx", `${((e.clientX - rect.left) / rect.width * 100)}%`);
          card.style.setProperty("--gy", `${((e.clientY - rect.top) / rect.height * 100)}%`);
        };
        card.addEventListener("mousemove", onMove);
        cleanups.push(() => card.removeEventListener("mousemove", onMove));
      });

      /* ── Steps section ── */
      gsap.from(".step-card", {
        x: -40,
        opacity: 0,
        stagger: 0.15,
        duration: 0.8,
        ease: "power3.out",
        scrollTrigger: { trigger: ".steps-section", start: "top 70%" },
      });

      /* ── Demo typewriter ── */
      const userMsg = "I'm building a fintech app with TypeScript. I prefer minimal, functional code and hate over-engineering.";
      const capturedMsg = '"fintech · TypeScript · minimal code · anti over-engineering"';

      const demoTl = gsap.timeline({
        scrollTrigger: { trigger: ".demo-section", start: "top 65%", once: true },
      });
      demoTl
        .from(".demo-container", { y: 40, opacity: 0, duration: 0.7, ease: "power3.out" })
        .to(".demo-user-text", {
          duration: userMsg.length * 0.028,
          text: { value: userMsg, delimiter: "" },
          ease: "none",
        }, "+=0.3")
        .from(".demo-divider", { scaleX: 0, duration: 0.4 }, "+=0.2")
        .from(".demo-result", { y: 10, opacity: 0, duration: 0.4 }, "+=0.1")
        .to(".demo-captured-text", {
          duration: capturedMsg.length * 0.03,
          text: { value: capturedMsg, delimiter: "" },
          ease: "none",
        });

      /* ── Testimonials ── */
      gsap.from(".testimonial-card", {
        y: 40,
        opacity: 0,
        stagger: 0.12,
        duration: 0.7,
        ease: "power3.out",
        scrollTrigger: { trigger: ".testimonials-grid", start: "top 75%" },
      });

      /* ── CTA ── */
      const ctaTl = gsap.timeline({
        scrollTrigger: { trigger: ".cta-section", start: "top 70%" },
      });
      ctaTl
        .from(".cta-title-line", { y: 40, opacity: 0, stagger: 0.1, duration: 0.7, ease: "power3.out" })
        .from(".cta-sub", { y: 20, opacity: 0, duration: 0.5 }, "-=0.3")
        .from(".cta-btn", { y: 20, opacity: 0, scale: 0.9, duration: 0.6, ease: "back.out(2)" }, "-=0.2");

      /* ── Magnetic buttons ── */
      document.querySelectorAll<HTMLElement>(".mag-btn").forEach(btn => {
        const onMove = (e: MouseEvent) => {
          const rect = btn.getBoundingClientRect();
          const dx = (e.clientX - rect.left - rect.width / 2) * 0.25;
          const dy = (e.clientY - rect.top - rect.height / 2) * 0.25;
          gsap.to(btn, { x: dx, y: dy, duration: 0.3, ease: "power2.out" });
        };
        const onLeave = () =>
          gsap.to(btn, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1, 0.4)" });
        btn.addEventListener("mousemove", onMove);
        btn.addEventListener("mouseleave", onLeave);
        cleanups.push(() => {
          btn.removeEventListener("mousemove", onMove);
          btn.removeEventListener("mouseleave", onLeave);
        });
      });

    }, rootRef);

    return () => {
      cleanups.forEach(fn => fn());
      ctx.revert();
    };
  }, []);

  return (
    <div ref={rootRef} className="landing-root">

      {/* ═════════════════════════════════════════════════════
          HERO — Full-impact dark section
      ═════════════════════════════════════════════════════ */}
      <section className="hero">
        {/* Ambient background */}
        <div className="hero-bg">
          <div className="hero-orb hero-orb-1" />
          <div className="hero-orb hero-orb-2" />
          <div className="hero-orb hero-orb-3" />
          <div className="hero-grid" />
        </div>

        <div className="hero-inner">
          {/* Left: Copy */}
          <div className="hero-copy">
            <div className="hero-pill">
              <span className="hero-pill-dot" />
              <span>Now supporting Claude, ChatGPT & Gemini</span>
              <ChevronRight size={14} />
            </div>

            <h1 className="hero-h1">
              <span className="hero-title-line">Your AI finally</span>
              <span className="hero-title-line hero-title-accent">remembers you.</span>
            </h1>

            <p className="hero-sub">
              Tallei gives every AI assistant persistent memory. Your preferences,
              context, and history — shared seamlessly across platforms.
            </p>

            <div className="hero-ctas">
              <Link href="/login" className="hero-cta hero-cta-primary mag-btn">
                Start for free
                <ArrowRight size={16} />
              </Link>
              <Link href="/dashboard/setup" className="hero-cta hero-cta-secondary mag-btn">
                How it works
              </Link>
            </div>

            <div className="hero-stats">
              {STATS.map((s, i) => (
                <div key={i} className="hero-stat">
                  <span className="hero-stat-val">{s.value}</span>
                  <span className="hero-stat-label">{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Visual */}
          <div className="hero-visual">
            <div className="hero-card-stack">
              {/* Main card */}
              <div className="hv-card hv-card-main">
                <div className="hv-card-header">
                  <MessageSquare size={14} className="hv-icon" />
                  <span>Memory Captured</span>
                  <span className="hv-badge-live">LIVE</span>
                </div>
                <div className="hv-card-body">
                  <div className="hv-memory-item">
                    <Sparkles size={12} className="hv-mi-icon" />
                    <div>
                      <span className="hv-mi-tag">Writing Style</span>
                      <span className="hv-mi-text">Concise, direct, no preambles</span>
                    </div>
                  </div>
                  <div className="hv-memory-item">
                    <Sparkles size={12} className="hv-mi-icon" />
                    <div>
                      <span className="hv-mi-tag">Tech Stack</span>
                      <span className="hv-mi-text">TypeScript, Next.js, PostgreSQL</span>
                    </div>
                  </div>
                  <div className="hv-memory-item">
                    <Sparkles size={12} className="hv-mi-icon" />
                    <div>
                      <span className="hv-mi-tag">Current Project</span>
                      <span className="hv-mi-text">Building a SaaS for AI memory</span>
                    </div>
                  </div>
                </div>
              </div>
              {/* Platform sync cards */}
              <div className="hv-card hv-card-mini hv-card-claude">
                <span className="hv-mini-dot" style={{ background: "#f97316" }} />
                <span>Claude — synced</span>
                <span className="hv-check">✓</span>
              </div>
              <div className="hv-card hv-card-mini hv-card-gpt">
                <span className="hv-mini-dot" style={{ background: "#10a37f" }} />
                <span>ChatGPT — synced</span>
                <span className="hv-check">✓</span>
              </div>
              <div className="hv-card hv-card-mini hv-card-gemini">
                <span className="hv-mini-dot" style={{ background: "#8b5cf6" }} />
                <span>Gemini — synced</span>
                <span className="hv-check">✓</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          MARQUEE
      ═════════════════════════════════════════════════════ */}
      <section className="marquee-section">
        <div className="marquee-label">TRUSTED BY TEAMS USING</div>
        <div className="marquee-wrap">
          <div className="marquee-track">
            {[...Array(3)].flatMap((_, batch) =>
              [
                { name: "Claude", color: "#f97316" },
                { name: "ChatGPT", color: "#10a37f" },
                { name: "Gemini", color: "#8b5cf6" },
              ].map((p, i) => (
                <div key={`${batch}-${i}`} className="marquee-chip">
                  <span className="marquee-dot" style={{ background: p.color }} />
                  {p.name}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FEATURES — Dense grid
      ═════════════════════════════════════════════════════ */}
      <section className="section features-section">
        <div className="section-inner">
          <div className="section-header">
            <span className="section-eyebrow">Features</span>
            <h2 className="section-title">Everything you need.<br />Nothing you don&apos;t.</h2>
            <p className="section-desc">Automatic, private, blazing fast. Cross-AI context that just works.</p>
          </div>

          <div className="features-grid">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <div key={i} className="feature-card" style={{ "--fc-accent": f.color } as React.CSSProperties}>
                  <div className="fc-icon-wrap">
                    <Icon size={20} strokeWidth={1.5} />
                  </div>
                  <h3 className="fc-title">{f.title}</h3>
                  <p className="fc-desc">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          HOW IT WORKS — Compact steps
      ═════════════════════════════════════════════════════ */}
      <section className="section steps-section">
        <div className="section-inner">
          <div className="section-header">
            <span className="section-eyebrow">How it works</span>
            <h2 className="section-title">Three steps. Zero effort.</h2>
          </div>

          <div className="steps-row">
            {STEPS.map((step, i) => (
              <div key={i} className={`step-card ${step.highlight ? "step-card-highlight" : ""}`}>
                <div className="step-visual">{step.visual}</div>
                <div className="step-num">Step {step.num}</div>
                <h3 className="step-title">{step.title}</h3>
                <p className="step-desc">{step.desc}</p>
                {i < STEPS.length - 1 && (
                  <div className="step-connector">
                    <ChevronRight size={16} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          DEMO — Terminal
      ═════════════════════════════════════════════════════ */}
      <section className="section demo-section">
        <div className="section-inner">
          <div className="section-header">
            <span className="section-eyebrow">Live Demo</span>
            <h2 className="section-title">See it in action</h2>
            <p className="section-desc">Watch Tallei capture context from a real conversation.</p>
          </div>

          <div className="demo-container">
            <div className="demo-chrome">
              <div className="demo-dots">
                <span style={{ background: "#ff5f57" }} />
                <span style={{ background: "#ffbd2e" }} />
                <span style={{ background: "#28c840" }} />
              </div>
              <span className="demo-title">tallei — memory capture</span>
            </div>
            <div className="demo-body">
              <div className="demo-label">→ User message</div>
              <p className="demo-user-text" />
              <div className="demo-divider" />
              <div className="demo-result">
                <span className="demo-badge">✓ CAPTURED</span>
                <span className="demo-captured-text" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          TESTIMONIALS
      ═════════════════════════════════════════════════════ */}
      <section className="section testimonials-section">
        <div className="section-inner">
          <div className="section-header">
            <span className="section-eyebrow">Testimonials</span>
            <h2 className="section-title">Loved by power users</h2>
          </div>

          <div className="testimonials-grid">
            {TESTIMONIALS.map((t, i) => (
              <div key={i} className="testimonial-card">
                <div className="tc-accent" style={{ background: t.accent }} />
                <p className="tc-quote">&ldquo;{t.quote}&rdquo;</p>
                <div className="tc-author">
                  <div className="tc-avatar">{t.initials}</div>
                  <div>
                    <div className="tc-name">{t.name}</div>
                    <div className="tc-role">{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          CTA — Final push
      ═════════════════════════════════════════════════════ */}
      <section className="cta-section">
        <div className="cta-bg">
          <div className="cta-orb cta-orb-1 hero-orb" />
          <div className="cta-orb cta-orb-2 hero-orb" />
        </div>
        <div className="cta-inner">
          <h2 className="cta-h2">
            <span className="cta-title-line">Stop repeating yourself</span>
            <span className="cta-title-line cta-title-accent">to every AI.</span>
          </h2>
          <p className="cta-sub">
            Give your AI assistants a shared, permanent memory. Free to start. Setup takes 2 minutes.
          </p>
          <Link href="/login" className="cta-btn mag-btn">
            Create your free account
            <ArrowRight size={18} />
          </Link>
          <p className="cta-note">No credit card required</p>
        </div>
      </section>

      {/* ═════════════════════════════════════════════════════
          FOOTER
      ═════════════════════════════════════════════════════ */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <span className="footer-brand">tallei</span>
          <span className="footer-copy">© 2026 Tallei. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}

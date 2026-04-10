"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowRight, RefreshCw, Globe, ShieldCheck } from "lucide-react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/* ─── Memory card data ─── */
const MEMORIES = [
  {
    emoji: "🎯",
    tag: "Goal",
    text: "Preparing a presentation for Friday's all-hands",
    rotation: -4,
    top: "0%",
    left: "0%",
    depth: 1,
  },
  {
    emoji: "🌿",
    tag: "Preference",
    text: "Trying to eat more plant-based this year",
    rotation: 3,
    top: "8%",
    left: "52%",
    depth: 0.75,
  },
  {
    emoji: "📍",
    tag: "Location",
    text: "Based in Austin — prefer US-based suggestions",
    rotation: 1.5,
    top: "56%",
    left: "6%",
    depth: 0.82,
  },
  {
    emoji: "💬",
    tag: "Style",
    text: "Keep answers brief. No long introductions.",
    rotation: -2,
    top: "52%",
    left: "54%",
    depth: 1,
  },
];

const FEATURES = [
  {
    icon: <RefreshCw size={20} strokeWidth={1.6} />,
    title: "No more repeating yourself",
    desc: "You say something once and every AI you use already knows it — today, next week, whenever you switch.",
  },
  {
    icon: <Globe size={20} strokeWidth={1.6} />,
    title: "Works with the AIs you already use",
    desc: "Claude, ChatGPT, and Gemini all connect to the same memory. Your context travels with you, not the app.",
  },
  {
    icon: <ShieldCheck size={20} strokeWidth={1.6} />,
    title: "Completely private",
    desc: "Your memories are yours alone. Nothing is shared, sold, or used to train any model. You're in full control.",
  },
];

export default function Home() {
  const cardsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);

    /* ── Hero cards entry + float ── */
    const cardEls = gsap.utils.toArray<HTMLElement>(".lp-mem-card");

    gsap.set(cardEls, { opacity: 0, y: 28, scale: 0.96 });
    gsap.to(cardEls, {
      opacity: (i) => MEMORIES[i].depth,
      y: 0,
      scale: 1,
      duration: 0.75,
      stagger: 0.14,
      ease: "power3.out",
      delay: 0.35,
      onComplete() {
        const amplitudes = [13, 9, 11, 15];
        const durations  = [3.4, 2.9, 3.7, 3.1];
        const rotates    = [2.2, 1.6, 2.0, 1.4];
        cardEls.forEach((card, i) => {
          gsap.to(card, {
            y: `-=${amplitudes[i]}`,
            rotation: `+=${rotates[i]}`,
            duration: durations[i],
            repeat: -1,
            yoyo: true,
            ease: "sine.inOut",
          });
        });
      },
    });

    /* ── Hero copy ── */
    gsap.fromTo(
      ".lp-hero-copy > *",
      { y: 22, opacity: 0 },
      { y: 0, opacity: 1, stagger: 0.1, duration: 0.7, ease: "power3.out", delay: 0.1 }
    );

    /* ── How it works ── */
    gsap.fromTo(
      ".lp-how-step",
      { y: 36, opacity: 0 },
      {
        y: 0, opacity: 1, stagger: 0.16, duration: 0.7, ease: "power3.out",
        scrollTrigger: { trigger: ".lp-how", start: "top 76%" },
      }
    );

    /* ── Features ── */
    gsap.fromTo(
      ".lp-feat-card",
      { y: 28, opacity: 0 },
      {
        y: 0, opacity: 1, stagger: 0.13, duration: 0.65, ease: "power3.out",
        scrollTrigger: { trigger: ".lp-feats", start: "top 78%" },
      }
    );

    /* ── CTA ── */
    gsap.fromTo(
      ".lp-end-inner > *",
      { y: 20, opacity: 0 },
      {
        y: 0, opacity: 1, stagger: 0.1, duration: 0.65, ease: "power3.out",
        scrollTrigger: { trigger: ".lp-end", start: "top 80%" },
      }
    );

    return () => ScrollTrigger.getAll().forEach((t) => t.kill());
  }, []);

  return (
    <main className="lp-wrap">

      {/* ── Ambient background ── */}
      <div className="lp-bg" aria-hidden="true">
        <div className="lp-glow lp-glow-a" />
        <div className="lp-glow lp-glow-b" />
        <div className="lp-glow lp-glow-c" />
      </div>

      {/* ══ HERO ══════════════════════════════════════ */}
      <section className="lp-hero">
        <div className="lp-hero-inner container">

          {/* Copy */}
          <div className="lp-hero-copy">

            <div className="lp-eyebrow">
              <span className="lp-live-dot" aria-hidden="true" />
              Synced across Claude · ChatGPT · Gemini
            </div>

            <h1 className="lp-h1">
              Your AI finally<br />
              <span className="lp-h1-accent">remembers you.</span>
            </h1>

            <p className="lp-hero-sub">
              You shouldn&apos;t have to re-explain your preferences,
              your work, or your life every time you start a new chat.
              Tallei saves what matters and shares it with every AI you use.
            </p>

            <div className="lp-actions">
              <Link href="/login" className="lp-cta-btn">
                Get started — it&apos;s free
              </Link>
              <Link href="/dashboard/setup" className="lp-text-btn">
                See how it works <ArrowRight size={14} />
              </Link>
            </div>

          </div>

          {/* Memory cards visual */}
          <div className="lp-cards-stage" ref={cardsRef} aria-hidden="true">
            {MEMORIES.map((m, i) => (
              <div
                key={i}
                className="lp-mem-card"
                style={{
                  top: m.top,
                  left: m.left,
                  transform: `rotate(${m.rotation}deg)`,
                }}
              >
                <div className="lp-mc-head">
                  <span className="lp-mc-emoji">{m.emoji}</span>
                  <span className="lp-mc-tag">{m.tag}</span>
                </div>
                <p className="lp-mc-text">{m.text}</p>
                <div className="lp-mc-platforms">
                  <span>Claude</span>
                  <span>ChatGPT</span>
                  <span>Gemini</span>
                </div>
              </div>
            ))}

            {/* Faint connector lines */}
            <svg className="lp-cards-svg" aria-hidden="true">
              <line x1="36%" y1="22%" x2="52%" y2="20%" strokeDasharray="4 4" />
              <line x1="20%" y1="30%" x2="14%" y2="58%" strokeDasharray="4 4" />
              <line x1="72%" y1="30%" x2="68%" y2="54%" strokeDasharray="4 4" />
            </svg>
          </div>
        </div>
      </section>

      {/* ══ HOW IT WORKS ══════════════════════════════ */}
      <section className="lp-how">
        <div className="container">
          <p className="lp-section-tag">How Tallei works</p>
          <h2 className="lp-section-h2">Three steps. Zero effort.</h2>

          <div className="lp-how-grid">
            <div className="lp-how-step">
              <div className="lp-how-num">01</div>
              <div className="lp-how-icon-wrap">💬</div>
              <h3 className="lp-how-title">Have a conversation</h3>
              <p className="lp-how-desc">
                Just talk to Claude, ChatGPT, or Gemini like you normally
                would. Mention your job, your diet, your goals — anything.
              </p>
            </div>

            <div className="lp-how-step lp-how-step-mid">
              <div className="lp-how-num accent">02</div>
              <div className="lp-how-icon-wrap accent">🧠</div>
              <h3 className="lp-how-title">Tallei quietly captures it</h3>
              <p className="lp-how-desc">
                Important details are automatically saved to your private
                memory. No extra steps, no copy-pasting, no checklists.
              </p>
            </div>

            <div className="lp-how-step">
              <div className="lp-how-num">03</div>
              <div className="lp-how-icon-wrap">✨</div>
              <h3 className="lp-how-title">Every AI is already caught up</h3>
              <p className="lp-how-desc">
                Open any AI assistant and it already knows your context.
                Switch freely — the memory moves with you, not the app.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ══ FEATURES ══════════════════════════════════ */}
      <section className="lp-feats">
        <div className="container">
          <div className="lp-feats-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="lp-feat-card">
                <div className="lp-feat-icon">{f.icon}</div>
                <h3 className="lp-feat-title">{f.title}</h3>
                <p className="lp-feat-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ END CTA ═══════════════════════════════════ */}
      <section className="lp-end">
        <div className="container">
          <div className="lp-end-inner">
            <div className="lp-end-glow" aria-hidden="true" />
            <p className="lp-end-overline">Get started today</p>
            <h2 className="lp-end-h2">
              Stop repeating yourself.<br />
              <span className="lp-end-accent">Start once. Remember forever.</span>
            </h2>
            <p className="lp-end-sub">
              Connect in 4 steps. No downloads, no configuration files, no
              technical setup required.
            </p>
            <Link href="/login" className="lp-cta-btn lp-cta-btn-lg">
              Create your free account
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

    </main>
  );
}

import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PaperBackground } from "./paper-background";
import { Floaty } from "./floaty";
import { HeroCardDeck } from "./hero-card-deck";

const FLOATY_ICONS = [
  { src: "/claude.svg", alt: "Claude", top: "12%", left: "8%", delay: 0 },
  { src: "/chatgpt.svg", alt: "ChatGPT", top: "22%", right: "12%", delay: 1.2 },
  { src: "/gemini.svg", alt: "Gemini", bottom: "18%", left: "14%", delay: 2.4 },
] as const;

export function HeroSection() {
  return (
    <header className="landing-hero" id="top">
      <PaperBackground variant="lined" className="landing-hero-paper" />

      <div className="landing-hero-ambient" aria-hidden>
        {FLOATY_ICONS.map((icon) => (
          <Floaty
            key={icon.alt}
            delay={icon.delay}
            duration={7 + icon.delay}
            className="landing-hero-float-icon"
          >
            <Image src={icon.src} alt="" width={28} height={28} />
          </Floaty>
        ))}
      </div>

      <div className="landing-hero-inner">
        <div className="landing-hero-copy">
          <h1 className="landing-hero-title">
            Say what you need.
            <br />
            We run the right loop.
          </h1>
          <p className="landing-hero-sub">
            Describe the work in plain English — weekly reports, inbox help, research digests.
            Tallei picks the right agents, remembers your preferences, and runs it on schedule.
          </p>
          <div className="landing-hero-actions">
            <Link href="/login" className="landing-cta">
              Start a loop
              <ArrowRight size={16} />
            </Link>
            <p className="landing-hero-proof">
              Powered by shared memory across ChatGPT, Claude &amp; Gemini — so you never re-explain yourself.
            </p>
            <a href="#showcase" className="landing-hero-scroll">
              See what people run ↓
            </a>
          </div>
        </div>

        <div className="landing-hero-visual">
          <HeroCardDeck />
        </div>
      </div>
    </header>
  );
}

"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Calendar, Sparkles } from "lucide-react";
import { HERO_INTENT, HERO_LOOP_CANDIDATES } from "./showcase-data";
import { cn } from "@/lib/utils";

export function HeroCardDeck() {
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"typing" | "deck" | "selected">("typing");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (phase !== "typing") return;
    if (typed.length >= HERO_INTENT.length) {
      const t = window.setTimeout(() => setPhase("deck"), 400);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setTyped(HERO_INTENT.slice(0, typed.length + 1));
    }, 28);
    return () => window.clearTimeout(t);
  }, [typed, phase]);

  useEffect(() => {
    if (phase !== "deck") return;
    const t = window.setTimeout(() => setPhase("selected"), 1200);
    return () => window.clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "selected") return;
    const interval = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % HERO_LOOP_CANDIDATES.length);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [phase]);

  const selected = HERO_LOOP_CANDIDATES[activeIndex];

  return (
    <div className="landing-hero-deck">
      <div className="landing-hero-deck-input">
        <span className="landing-hero-deck-label">Your intent</span>
        <p className="landing-hero-deck-prompt">
          {typed}
          {phase === "typing" && <span className="landing-hero-deck-cursor" />}
        </p>
      </div>

      <div className="landing-hero-deck-stack" aria-live="polite">
        <AnimatePresence mode="popLayout">
          {phase !== "typing" &&
            HERO_LOOP_CANDIDATES.map((card, index) => {
              const isTop = index === activeIndex;
              const offset = (index - activeIndex + HERO_LOOP_CANDIDATES.length) % HERO_LOOP_CANDIDATES.length;
              if (offset > 2) return null;

              return (
                <motion.button
                  key={card.title}
                  type="button"
                  className={cn("landing-hero-deck-card", isTop && "landing-hero-deck-card--top")}
                  initial={{ opacity: 0, y: 24, rotate: offset * 4 - 4 }}
                  animate={{
                    opacity: offset === 0 ? 1 : 0.55 - offset * 0.15,
                    y: offset * 14,
                    x: offset * 10,
                    rotate: offset * 3 - 2,
                    scale: 1 - offset * 0.04,
                    zIndex: 10 - offset,
                  }}
                  transition={{ type: "spring", stiffness: 260, damping: 24 }}
                  onClick={() => {
                    setActiveIndex(index);
                    setPhase("selected");
                  }}
                  style={{ pointerEvents: phase === "selected" ? "auto" : "none" }}
                >
                  <div className="landing-hero-deck-card-head">
                    <Sparkles className="size-3.5 text-[var(--landing-accent)]" />
                    <span>{card.title}</span>
                  </div>
                  <div className="landing-hero-deck-agents">
                    {card.agents.map((agent, i) => (
                      <span key={agent}>
                        {i > 0 && <span className="landing-hero-deck-arrow">→</span>}
                        {agent}
                      </span>
                    ))}
                  </div>
                  {isTop && phase === "selected" && (
                    <motion.div
                      className="landing-hero-deck-schedule"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                    >
                      <Calendar className="size-3" />
                      Every Friday, 9am
                    </motion.div>
                  )}
                </motion.button>
              );
            })}
        </AnimatePresence>
      </div>

      {phase === "selected" && (
        <p className="landing-hero-deck-hint">Click a card to see another match</p>
      )}
    </div>
  );
}

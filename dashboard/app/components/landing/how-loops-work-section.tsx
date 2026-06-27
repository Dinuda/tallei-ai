"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    num: "01",
    title: "Describe it",
    body: "Tell Tallei what should repeat — in your words, not workflow jargon.",
  },
  {
    num: "02",
    title: "We design the loop",
    body: "Agents, tools, and handoffs are architected from your intent and memory.",
  },
  {
    num: "03",
    title: "It runs on schedule",
    body: "Review gates when you need them. Otherwise it just runs.",
  },
] as const;

export function HowLoopsWorkSection() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    const interval = window.setInterval(() => {
      setActive((i) => (i + 1) % STEPS.length);
    }, 4500);
    return () => window.clearInterval(interval);
  }, [paused]);

  return (
    <section id="how-it-works" className="landing-how">
      <div className="landing-section-inner">
        <div className="landing-section-header">
          <h2 className="landing-section-title">How loops work</h2>
          <p className="landing-section-sub">
            Three steps. You only do the first one.
          </p>
        </div>

        <div
          className="landing-progress-cards"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="landing-progress-rail" aria-hidden>
            <motion.div
              className="landing-progress-fill"
              animate={{ height: `${((active + 1) / STEPS.length) * 100}%` }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>

          <div className="landing-progress-list">
          {STEPS.map((step, index) => {
            const isActive = index === active;
            return (
              <button
                key={step.num}
                type="button"
                className={cn(
                  "landing-progress-card",
                  isActive && "landing-progress-card--active",
                )}
                onClick={() => {
                  setActive(index);
                  setPaused(true);
                }}
              >
                <span className="landing-progress-num">{step.num}</span>
                <div className="landing-progress-body">
                  <h3>{step.title}</h3>
                  <motion.p
                    initial={false}
                    animate={{
                      opacity: isActive ? 1 : 0.5,
                      height: isActive ? "auto" : 0,
                      marginTop: isActive ? "0.5rem" : 0,
                    }}
                    transition={{ duration: 0.35 }}
                    className="landing-progress-desc"
                  >
                    {step.body}
                  </motion.p>
                </div>
              </button>
            );
          })}
          </div>
        </div>
      </div>
    </section>
  );
}

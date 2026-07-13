"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Calendar } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { SHOWCASE_LOOPS, type ShowcaseLoop } from "./showcase-data";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "work", label: "Work" },
  { id: "content", label: "Content" },
  { id: "ops", label: "Ops" },
] as const;

function LoopAgents({ agents }: { agents: string[] }) {
  return (
    <div className="landing-loop-agents">
      {agents.map((agent, i) => (
        <span key={agent} className="landing-loop-agent">
          {i > 0 && <span className="landing-loop-agent-sep">→</span>}
          {agent}
        </span>
      ))}
    </div>
  );
}

function FeaturedCard({ loop }: { loop: ShowcaseLoop }) {
  return (
    <motion.article
      key={loop.id}
      className="landing-showcase-featured"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.35 }}
    >
      <div className="landing-showcase-featured-top">
        <span className="landing-showcase-cadence">
          <Calendar className="size-3.5" />
          {loop.cadence}
        </span>
        <span className="landing-showcase-category">{loop.category}</span>
      </div>
      <h3 className="landing-showcase-featured-title">{loop.title}</h3>
      <p className="landing-showcase-intent">&ldquo;{loop.intent}&rdquo;</p>
      <LoopAgents agents={loop.agents} />
      {loop.outputPreview && (
        <p className="landing-showcase-preview">{loop.outputPreview}</p>
      )}
      <Link href="/login" className="landing-showcase-featured-cta">
        Run something like this
        <ArrowRight size={14} />
      </Link>
    </motion.article>
  );
}

function GridCard({
  loop,
  active,
  onSelect,
}: {
  loop: ShowcaseLoop;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("landing-showcase-card", active && "landing-showcase-card--active")}
      onClick={onSelect}
    >
      <span className="landing-showcase-card-cadence">{loop.cadence}</span>
      <h4 className="landing-showcase-card-title">{loop.title}</h4>
      <LoopAgents agents={loop.agents} />
    </button>
  );
}

export function ShowcaseSection() {
  const [filter, setFilter] = useState<"all" | ShowcaseLoop["category"]>("all");
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const filtered = filter === "all"
    ? SHOWCASE_LOOPS
    : SHOWCASE_LOOPS.filter((l) => l.category === filter);

  const featured = filtered[featuredIndex % filtered.length] ?? SHOWCASE_LOOPS[0];

  const selectLoop = useCallback((index: number) => {
    setFeaturedIndex(index);
    setPaused(true);
  }, []);

  useEffect(() => {
    setFeaturedIndex(0);
  }, [filter]);

  useEffect(() => {
    if (paused || filtered.length <= 1) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    const interval = window.setInterval(() => {
      setFeaturedIndex((i) => (i + 1) % filtered.length);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [paused, filtered.length]);

  return (
    <section id="showcase" className="landing-showcase">
      <div className="landing-section-inner">
        <div className="landing-section-header">
          <h2 className="landing-section-title">Loops people actually run</h2>
          <p className="landing-section-sub">
            No templates to configure. These started as a sentence — Tallei designed the rest.
          </p>
        </div>

        <div className="landing-showcase-filters">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={cn(
                "landing-filter-pill",
                filter === cat.id && "landing-filter-pill--active",
              )}
              onClick={() => {
                setFilter(cat.id);
                setPaused(false);
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div
          className="landing-showcase-grid"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <AnimatePresence mode="wait">
            <FeaturedCard loop={featured} />
          </AnimatePresence>

          <div className="landing-showcase-cards">
            {filtered.map((loop, index) => (
              <GridCard
                key={loop.id}
                loop={loop}
                active={loop.id === featured.id}
                onSelect={() => selectLoop(index)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

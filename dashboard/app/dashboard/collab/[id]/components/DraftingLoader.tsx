"use client";

import { useRef, useLayoutEffect } from "react";
import gsap from "gsap";
import styles from "./DraftingLoader.module.css";

type CollabActor = "chatgpt" | "claude";

interface DraftingLoaderProps {
  actor: CollabActor;
  className?: string;
}

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
};

const LINE_LENGTHS = [16, 16, 16, 16, 19.7];

const LINE_COLORS = [
  "#7eb71b", // accent
  "#9fd13a", // lighter lime
  "#5a9412", // darker lime
  "#b8e060", // pale lime
  "#3d5c18", // dark green slash
];

export default function DraftingLoader({ actor, className = "" }: DraftingLoaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<(SVGLineElement | null)[]>([]);

  useLayoutEffect(() => {
    const lines = linesRef.current.filter(Boolean) as SVGLineElement[];
    if (lines.length === 0) return;

    const ctx = gsap.context(() => {
      lines.forEach((line, i) => {
        const len = LINE_LENGTHS[i];
        gsap.set(line, {
          strokeDasharray: len,
          strokeDashoffset: len,
        });
      });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.35 });

      lines.slice(0, 4).forEach((line) => {
        tl.to(line, { strokeDashoffset: 0, duration: 0.25, ease: "power2.out" });
      });

      tl.to(lines[4], { strokeDashoffset: 0, duration: 0.35, ease: "power2.out" });
      tl.to({}, { duration: 0.3 });
      tl.to(lines, { strokeDashoffset: (i) => LINE_LENGTHS[i], duration: 0.2, ease: "power2.in", stagger: 0.03 });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} className={`${styles.loader} ${className}`}>
      <div className={styles.tally}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="4" x2="5" y2="20" stroke={LINE_COLORS[0]} ref={(el) => { linesRef.current[0] = el; }} />
          <line x1="9" y1="4" x2="9" y2="20" stroke={LINE_COLORS[1]} ref={(el) => { linesRef.current[1] = el; }} />
          <line x1="13" y1="4" x2="13" y2="20" stroke={LINE_COLORS[2]} ref={(el) => { linesRef.current[2] = el; }} />
          <line x1="17" y1="4" x2="17" y2="20" stroke={LINE_COLORS[3]} ref={(el) => { linesRef.current[3] = el; }} />
          <line x1="2" y1="8" x2="20" y2="16" stroke={LINE_COLORS[4]} ref={(el) => { linesRef.current[4] = el; }} />
        </svg>
      </div>
      <span className={styles.label}>
        {ACTOR_LABEL[actor]} is drafting…
      </span>
    </div>
  );
}

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

export default function DraftingLoader({ actor, className = "" }: DraftingLoaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useLayoutEffect(() => {
    const dots = dotsRef.current.filter(Boolean) as HTMLSpanElement[];
    if (dots.length === 0) return;

    const ctx = gsap.context(() => {
      // Staggered wave: each dot scales up and down with a glow
      gsap.fromTo(
        dots,
        { scale: 0.5, opacity: 0.35 },
        {
          scale: 1,
          opacity: 1,
          duration: 0.6,
          stagger: {
            each: 0.14,
            repeat: -1,
            yoyo: true,
          },
          ease: "power1.inOut",
        }
      );
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} className={`${styles.loader} ${className}`}>
      <div className={styles.dots}>
        {Array.from({ length: 4 }).map((_, i) => (
          <span
            key={i}
            ref={(el) => { dotsRef.current[i] = el; }}
            className={styles.dot}
          />
        ))}
      </div>
      <span className={styles.label}>
        {ACTOR_LABEL[actor]} is drafting…
      </span>
    </div>
  );
}

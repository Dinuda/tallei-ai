"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const enterTransition = {
  duration: 0.32,
  ease: [0.16, 1, 0.3, 1] as const,
};

export function TranscriptPartEnter({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <>{children}</>;
  }

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      initial={{ opacity: 0, y: 10 }}
      transition={enterTransition}
    >
      {children}
    </motion.div>
  );
}

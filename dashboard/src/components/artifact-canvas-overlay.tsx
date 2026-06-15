"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";

export function ArtifactCanvasOverlay({
  children,
  onClose,
  open,
  title = "Artifact",
}: {
  children: React.ReactNode;
  onClose: () => void;
  open: boolean;
  title?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          aria-label={title}
          className="fixed inset-0 z-[200] flex flex-col bg-white"
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 28 }}
          role="dialog"
          transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

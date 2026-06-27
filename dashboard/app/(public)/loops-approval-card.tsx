"use client";

import { useEffect, useState } from "react";

const LINES = [
  "Looks like a habit.",
  "You've created similar newsletters 3 times recently.",
  "Want me to prepare one every Friday?",
] as const;

const BEFORE_ITEMS = [
  "Write newsletter",
  "Draft investor update",
  "Summarize customer call",
  "Create changelog",
] as const;

const AFTER_ITEMS = [
  "Weekly newsletter loop",
  "Investor update loop",
  "Meeting follow-up loop",
  "Changelog loop",
] as const;

export function LoopsApprovalCard() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [showButtons, setShowButtons] = useState(false);
  const [activeButton, setActiveButton] = useState<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setVisibleLines(LINES.length);
      setShowButtons(true);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];

    LINES.forEach((_, index) => {
      timers.push(
        setTimeout(() => setVisibleLines(index + 1), 400 + index * 900),
      );
    });

    timers.push(
      setTimeout(() => setShowButtons(true), 400 + LINES.length * 900 + 300),
    );

    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="loops-approval-wrap">
      <div className="loops-approval-card" aria-label="Loop detection suggestion">
        <div className="loops-approval-header">
          <span className="loops-approval-dot" aria-hidden />
          <span className="loops-mono loops-approval-label">Tallei</span>
        </div>

        <div className="loops-approval-body">
          {LINES.map((line, index) => (
            <p
              key={line}
              className={`loops-approval-line${index < visibleLines ? " loops-approval-line--visible" : ""}`}
            >
              {line}
            </p>
          ))}

          <div
            className={`loops-approval-actions${showButtons ? " loops-approval-actions--visible" : ""}`}
          >
            {(["Automate", "Ignore", "Show why"] as const).map((label, index) => (
              <button
                key={label}
                type="button"
                className={`loops-mono loops-approval-btn${index === 0 ? " loops-approval-btn--primary" : ""}${activeButton === index ? " loops-approval-btn--active" : ""}`}
                onClick={() => setActiveButton(index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="loops-before-after">
        <div className="loops-before-after-col">
          <span className="loops-mono loops-before-after-label">Before</span>
          <ul className="loops-before-after-list">
            {BEFORE_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="loops-before-after-divider" aria-hidden />
        <div className="loops-before-after-col">
          <span className="loops-mono loops-before-after-label">After</span>
          <ul className="loops-before-after-list loops-before-after-list--detected">
            {AFTER_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

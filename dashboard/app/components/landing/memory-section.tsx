import type { CSSProperties } from "react";
import Image from "next/image";

const MEMORY_POINTS = [
  {
    title: "Save once",
    body: "Tell one AI how you work. Tallei remembers tone, preferences, and context.",
  },
  {
    title: "Recall everywhere",
    body: "ChatGPT, Claude, Gemini — every tool pulls from the same memory layer.",
  },
  {
    title: "Loops get smarter",
    body: "Each run learns from the last. Your automations stay personal.",
  },
] as const;

export function MemorySection() {
  return (
    <section id="memory" className="landing-memory">
      <div className="landing-section-inner landing-memory-inner">
        <div className="landing-memory-copy">
          <h2 className="landing-section-title">Every loop remembers you</h2>
          <p className="landing-section-sub landing-memory-sub">
            Memory isn&apos;t a separate product. It&apos;s what makes loops feel like they were built for you — not a template.
          </p>
          <ul className="landing-memory-list">
            {MEMORY_POINTS.map((point) => (
              <li key={point.title}>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="landing-memory-visual" aria-hidden>
          <div className="landing-memory-orbit">
            <div className="landing-memory-core">
              <Image src="/tallei.svg" alt="" width={32} height={32} />
            </div>
            {[
              { src: "/claude.svg", label: "Claude" },
              { src: "/chatgpt.svg", label: "ChatGPT" },
              { src: "/gemini.svg", label: "Gemini" },
            ].map((tool, i) => (
              <div
                key={tool.label}
                className="landing-memory-satellite"
                style={{ "--orbit-i": i } as CSSProperties}
              >
                <Image src={tool.src} alt="" width={24} height={24} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

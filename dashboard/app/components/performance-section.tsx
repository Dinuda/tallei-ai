import Image from "next/image";
import { Check, X } from "lucide-react";
import "../styles/performance-section.css";

export function PerformanceSection() {
  return (
    <section className="performance-section" aria-label="Why Tallei performs better">
      <div className="performance-inner">
        <div className="performance-header">
          <p className="performance-eyebrow">Why Tallei</p>
          <h2 className="performance-heading">
            Fast. Invisible.
            <br />
            <span>Just works.</span>
          </h2>
          <p className="performance-sub">
            No dashboards. No config. Tallei runs quietly in the background.
          </p>
        </div>

        <div className="performance-metrics">
          <article className="performance-metric-card">
            <h3>&lt;300ms</h3>
            <p className="performance-metric-title">Blazingly fast</p>
            <p className="performance-metric-copy">No spinner. No wait. Memory that feels like nothing.</p>
          </article>

          <article className="performance-metric-card performance-metric-card-icons">
            <div>
              <h3>Any AI</h3>
              <p className="performance-metric-title">Your tools, your choice</p>
              <p className="performance-metric-copy">All in sync. Always.</p>
            </div>
            <div className="performance-logo-row">
              <Image src="/chatgpt.svg" alt="ChatGPT" width={18} height={18} />
              <span>+</span>
              <Image src="/claude.svg" alt="Claude" width={18} height={18} />
              <span>+</span>
              <Image src="/gemini.svg" alt="Gemini" width={18} height={18} />
              <small>+ more</small>
            </div>
          </article>

          <article className="performance-metric-card performance-metric-card-icons">
            <div>
              <h3>Zero</h3>
              <p className="performance-metric-title">Zero setup</p>
              <p className="performance-metric-copy">Minutes to connect. Nothing to maintain.</p>
            </div>
            <div className="performance-logo-row">
              <Image src="/chatgpt.svg" alt="ChatGPT" width={18} height={18} />
              <span>+</span>
              <Image src="/claude.svg" alt="Claude" width={18} height={18} />
              <span>+</span>
              <Image src="/gemini.svg" alt="Gemini" width={18} height={18} />
            </div>
          </article>
        </div>

        <div className="performance-compare">
          <div className="performance-column performance-column-muted">
            <div className="performance-column-head">
              <h4>Without Tallei</h4>
              <p>The status quo</p>
            </div>
            <ul>
              <li><X size={16} />Start over every session</li>
              <li><X size={16} />Decisions disappear at end of session</li>
              <li><X size={16} />Re-explain yourself every time</li>
              <li><X size={16} />Days of engineering to connect tools</li>
              <li><X size={16} />Files trapped in one tool</li>
            </ul>
          </div>

          <div className="performance-column performance-column-accent">
            <div className="performance-column-head">
              <h4>With Tallei</h4>
              <p>How it should work</p>
            </div>
            <ul>
              <li><Check size={16} />Context follows you from tool to tool</li>
              <li><Check size={16} />Everything remembered, every time</li>
              <li><Check size={16} />Your profile travels with you</li>
              <li><Check size={16} />Live in minutes. No engineering.</li>
              <li><Check size={16} />Surfaces everywhere, automatically</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

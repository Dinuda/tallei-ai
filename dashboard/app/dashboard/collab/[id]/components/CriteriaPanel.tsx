"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Check, AlertCircle, Minus } from "lucide-react";
import styles from "./CriteriaPanel.module.css";

type EvaluationStatus = "pass" | "fail" | "partial";

interface Criterion {
  id: string;
  text: string;
  weight: number;
}

interface Evaluation {
  criterion_id: string;
  status: EvaluationStatus;
  rationale: string;
}

interface EvaluationEntry {
  iteration: number;
  actor: "chatgpt" | "claude";
  ts: string;
  criterion_evaluations: Evaluation[];
  should_mark_done: boolean;
  remaining_work: string;
}

const STATUS_CONFIG: Record<EvaluationStatus, { icon: React.ReactNode; bg: string; border: string; text: string }> = {
  pass: {
    icon: <Check size={12} />,
    bg: "var(--status-success-bg)",
    border: "var(--status-success-border)",
    text: "var(--status-success-text)",
  },
  partial: {
    icon: <Minus size={12} />,
    bg: "var(--status-warning-bg)",
    border: "var(--status-warning-border)",
    text: "var(--status-warning-text)",
  },
  fail: {
    icon: <AlertCircle size={12} />,
    bg: "var(--status-error-bg)",
    border: "var(--status-error-border)",
    text: "var(--status-error-text)",
  },
};

interface CriteriaPanelProps {
  planSummary: string | null;
  criteria: Criterion[];
  evaluations: EvaluationEntry[];
  latestStatusMap: Map<string, EvaluationStatus>;
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(delta / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function CriteriaPanel({ planSummary, criteria, evaluations, latestStatusMap }: CriteriaPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const latestEvaluation = evaluations.length > 0 ? evaluations[evaluations.length - 1] : null;

  const passCount = criteria.filter((c) => latestStatusMap.get(c.id) === "pass").length;
  const totalCount = criteria.length;

  return (
    <div className={styles.panel}>
      <button type="button" className={styles.toggle} onClick={() => setExpanded((v) => !v)}>
        <div className={styles.toggleLeft}>
          <span className={styles.toggleLabel}>Plan & Criteria</span>
          {totalCount > 0 && (
            <span className={styles.toggleProgress}>
              {passCount}/{totalCount} passed
            </span>
          )}
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div className={styles.content}>
          {planSummary && (
            <div className={styles.summary}>
              <p className={styles.summaryText}>{planSummary}</p>
            </div>
          )}

          {criteria.length > 0 && (
            <div className={styles.criteriaList}>
              {criteria.map((criterion) => {
                const status = latestStatusMap.get(criterion.id) ?? "pending";
                const config = status !== "pending" ? STATUS_CONFIG[status] : null;

                return (
                  <div key={criterion.id} className={styles.criteriaRow}>
                    <div className={styles.criteriaInfo}>
                      <p className={styles.criteriaText}>{criterion.text}</p>
                      <p className={styles.criteriaMeta}>
                        Weight {criterion.weight}
                      </p>
                    </div>
                    {config ? (
                      <span
                        className={styles.criteriaStatus}
                        style={{
                          background: config.bg,
                          borderColor: config.border,
                          color: config.text,
                        }}
                      >
                        {config.icon}
                        <span>{status}</span>
                      </span>
                    ) : (
                      <span className={styles.criteriaStatusPending}>pending</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {latestEvaluation && (
            <div className={styles.evaluation}>
              <p className={styles.evaluationTitle}>Latest Evaluation</p>
              <p className={styles.evaluationMeta}>
                Turn {latestEvaluation.iteration} · {relativeTime(latestEvaluation.ts)}
              </p>
              {latestEvaluation.remaining_work && (
                <p className={styles.evaluationRemaining}>{latestEvaluation.remaining_work}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

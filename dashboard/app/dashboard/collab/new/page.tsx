"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./page.module.css";

type FirstActor = "chatgpt" | "claude";

const STEPS = ["Title", "Starter", "Cap"];

export default function CollabTaskWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [firstActor, setFirstActor] = useState<FirstActor>("chatgpt");
  const [maxIterations, setMaxIterations] = useState(4);

  const canContinue = useMemo(() => {
    if (step === 0) return title.trim().length > 0;
    return true;
  }, [step, title]);

  const createTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/collab/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          brief: brief.trim() || undefined,
          firstActor,
          maxIterations,
        }),
      });
      const body = await res.json();
      if (!res.ok || typeof body?.id !== "string") {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to create task");
      }
      router.push(`/dashboard/collab/${body.id}`);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>New Collab Task</h1>
        <div className={styles.dots}>
          {STEPS.map((label, idx) => (
            <span key={label} className={`${styles.dot} ${idx <= step ? styles.dotActive : ""}`} />
          ))}
        </div>
      </header>

      {step === 0 && (
        <section className={styles.card}>
          <h2>Title and brief</h2>
          <input
            className={styles.input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Draft the Series A deck"
          />
          <textarea
            className={styles.textarea}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Include product narrative, GTM story, and metrics assumptions."
          />
        </section>
      )}

      {step === 1 && (
        <section className={styles.card}>
          <h2>Who starts?</h2>
          <div className={styles.actorGrid}>
            <button
              type="button"
              className={`${styles.actorCard} ${firstActor === "chatgpt" ? styles.actorCardActive : ""}`}
              onClick={() => setFirstActor("chatgpt")}
            >
              <strong>ChatGPT</strong>
              <span>Creative pass first</span>
            </button>
            <button
              type="button"
              className={`${styles.actorCard} ${firstActor === "claude" ? styles.actorCardActive : ""}`}
              onClick={() => setFirstActor("claude")}
            >
              <strong>Claude</strong>
              <span>Technical pass first</span>
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className={styles.card}>
          <h2>Iteration cap</h2>
          <input
            type="range"
            min={1}
            max={8}
            value={maxIterations}
            onChange={(event) => setMaxIterations(Number(event.target.value))}
            className={styles.slider}
          />
          <p className={styles.helper}>{maxIterations} turns max (1-8)</p>
        </section>
      )}

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => (step === 0 ? router.push("/dashboard/collab") : setStep(step - 1))}
          disabled={busy}
        >
          Back
        </button>

        {step < 2 ? (
          <button type="button" className={styles.primaryBtn} disabled={!canContinue || busy} onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void createTask()}>
            {busy ? "Creating..." : "Create Task"}
          </button>
        )}
      </footer>
    </div>
  );
}

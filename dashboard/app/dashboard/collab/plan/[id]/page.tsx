"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, FolderOpen, PlusCircle } from "lucide-react";

import styles from "./page.module.css";

type CollabTask = {
  id: string;
  title: string;
};

export default function CollabPlanMigrationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? "";

  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<CollabTask | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function resolveTask() {
      setLoading(true);
      try {
        const res = await fetch(`/api/collab/tasks/${id}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok || typeof body?.id !== "string") {
          if (!cancelled) setTask(null);
          return;
        }
        if (!cancelled) {
          setTask({ id: body.id, title: body.title });
          router.replace(`/dashboard/collab/${body.id}`);
        }
      } catch {
        if (!cancelled) setTask(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void resolveTask();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Redirecting to unified Collab task…</p>
        </div>
      </div>
    );
  }

  if (task) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Opening <strong>{task.title}</strong>…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.iconWrap}>
          <FolderOpen size={32} strokeWidth={1.5} />
        </div>
        <h1 className={styles.title}>Planner Sessions Migrated</h1>
        <p className={styles.text}>
          Orchestrate sessions were merged into Collab tasks. Create a new task or open an existing one from the Collab dashboard.
        </p>
        <div className={styles.actions}>
          <Link href="/dashboard/collab/new" className={styles.primaryBtn}>
            <PlusCircle size={16} />
            Create new collab task
          </Link>
          <Link href="/dashboard/collab" className={styles.secondaryBtn}>
            Open collab tasks
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}

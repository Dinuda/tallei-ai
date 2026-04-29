"use client";

import type { ReactNode } from "react";
import styles from "./CollabLayout.module.css";

export default function CollabLayout({
  content,
  sidebar,
}: {
  content: ReactNode;
  sidebar: ReactNode;
}) {
  return (
    <div className={styles.layout}>
      <div className={styles.content}>{content}</div>
      <aside className={styles.sidebar}>{sidebar}</aside>
    </div>
  );
}

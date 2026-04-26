"use client";

import type React from "react";
import Link from "next/link";
import { Box, Brain, X } from "lucide-react";
import styles from "./empty-collection-state.module.css";

type EmptyCollectionStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  illustration?: "default" | "none";
  imageSrc?: string;
  imageAlt?: string;
  actionIcon?: React.ReactNode;
};

export function EmptyCollectionState({
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  illustration = "none",
  imageSrc,
  imageAlt = "",
  actionIcon,
}: EmptyCollectionStateProps) {
  const hasDefaultIllustration = illustration === "default" && !imageSrc;
  const hasCustomImage = Boolean(imageSrc);
  const hasArtwork = hasDefaultIllustration || hasCustomImage;

  const defaultIcon = <Box size={18} />;
  const icon = actionIcon ?? defaultIcon;

  const action = actionLabel
    ? actionHref
      ? (
        <Link href={actionHref} className={styles.action}>
          {icon}
          {actionLabel}
        </Link>
      )
      : onAction
        ? (
          <button type="button" className={styles.action} onClick={onAction}>
            {icon}
            {actionLabel}
          </button>
        )
        : null
    : null;

  return (
    <div className={`${styles.wrap} ${hasArtwork ? styles.withArtwork : styles.withoutArtwork}`}>
      {hasCustomImage ? (
        <img src={imageSrc} alt={imageAlt} className={styles.imageArtwork} />
      ) : hasDefaultIllustration ? (
        <div className={styles.illustration} aria-hidden>
          <div className={styles.backCard} />
          <div className={styles.frontCard}>
            <Brain size={27} className={styles.brand} />
            <div className={`${styles.row} ${styles.rowSm}`} />
            <div className={`${styles.row} ${styles.rowMd}`} />
            <div className={`${styles.row} ${styles.rowLg}`} />
            <div className={styles.closeDot}>
              <X size={20} strokeWidth={2.5} />
            </div>
          </div>
        </div>
      ) : null}

      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description}</p>
      {action}
    </div>
  );
}

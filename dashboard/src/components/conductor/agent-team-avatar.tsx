"use client";

import { createAvatar } from "@dicebear/core";
import * as dylan from "@dicebear/dylan";
import { useMemo } from "react";

const HAPPY_MOODS = ["happy", "superHappy", "hopeful"] as const;
const SKIN_TONES = ["f5d0c5", "eab7a1", "d89878", "c68642", "8d5524", "613f1d"] as const;
const HAIR_COLORS = ["2c1b18", "4a312c", "724133", "a55728", "b58143", "d6b370", "e8e1e1", "f59797", "ffd5dc", "b8e986"] as const;
const BACKGROUND_COLORS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "e6f5c8", "fde68a"] as const;

export function AgentTeamAvatar({
  seed,
  size = 40,
  alt,
  className,
}: {
  seed: string;
  size?: number;
  alt: string;
  className?: string;
}) {
  const dataUri = useMemo(
    () => createAvatar(dylan, {
      seed,
      size,
      mood: [...HAPPY_MOODS],
      skinColor: [...SKIN_TONES],
      hairColor: [...HAIR_COLORS],
      backgroundColor: [...BACKGROUND_COLORS],
    }).toDataUri(),
    [seed, size],
  );

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt}
      className={className}
      draggable={false}
      height={size}
      src={dataUri}
      width={size}
    />
  );
}

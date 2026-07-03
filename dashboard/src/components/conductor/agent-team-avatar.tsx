"use client";

import { createAvatar } from "@dicebear/core";
import * as dylan from "@dicebear/dylan";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

const HAPPY_MOODS = ["happy", "superHappy", "hopeful"] as const;
const SKIN_TONES = ["f5d0c5", "eab7a1", "d89878", "c68642", "8d5524", "613f1d"] as const;
const HAIR_COLORS = ["2c1b18", "4a312c", "724133", "a55728", "b58143", "d6b370", "e8e1e1", "f59797", "ffd5dc", "b8e986"] as const;
const BACKGROUND_COLORS = [
  "38bdf8",
  "a78bfa",
  "818cf8",
  "fb7185",
  "fb923c",
  "4ade80",
  "facc15",
  "f472b6",
] as const;

const AVATAR_GLOW_SHADOWS = [
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(56,189,248,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(167,139,250,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(129,140,248,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(251,113,133,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(251,146,60,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(74,222,128,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(250,204,21,0.42)]",
  "shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(244,114,182,0.42)]",
] as const;

function seedAccentIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash + seed.charCodeAt(index)) % 9973;
  }
  return hash % BACKGROUND_COLORS.length;
}

export function rosterAvatarShellClassName(seed: string): string {
  return cn("inline-flex shrink-0 rounded-full", AVATAR_GLOW_SHADOWS[seedAccentIndex(seed)]);
}

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
      className={cn("rounded-full object-cover", className)}
      draggable={false}
      height={size}
      src={dataUri}
      width={size}
    />
  );
}

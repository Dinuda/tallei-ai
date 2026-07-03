import type { UIMessage } from "ai";

type TranscriptPart = NonNullable<UIMessage["parts"]>[number];

export type TranscriptSegment =
  | { type: "part"; part: TranscriptPart }
  | { type: "patch-beat"; parts: TranscriptPart[] };

function isToolPartType(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

function isPatchLoopSpecPart(part: TranscriptPart): boolean {
  if (!isToolPartType(part.type)) return false;
  return (part as { toolName?: string }).toolName === "patchLoopSpec";
}

/**
 * Narrative order for assistant transcript parts:
 * prose → tool/result cards → reflection (thought) → next prose.
 *
 * patchLoopSpec is special: keep any thought between the prose and the patch
 * so "thought → text → Making changes…" reads as one beat.
 */
export function reorderAssistantTranscriptParts(parts: TranscriptPart[]): TranscriptPart[] {
  if (parts.length < 2) return parts;

  let index = 0;
  const leadingReasonings: TranscriptPart[] = [];
  while (index < parts.length && parts[index].type === "reasoning") {
    leadingReasonings.push(parts[index]);
    index += 1;
  }

  const reordered = reorderTextThenToolThenThought(parts.slice(index));
  if (leadingReasonings.length === 0) return reordered;

  return attachLeadingReasonings(reordered, leadingReasonings);
}

/**
 * Group the concluding patch beat: thought(s) + prose + Making changes… card.
 */
export function buildTranscriptSegments(parts: TranscriptPart[]): TranscriptSegment[] {
  const ordered = reorderAssistantTranscriptParts(parts);
  const segments: TranscriptSegment[] = [];
  let index = 0;

  while (index < ordered.length) {
    const patchIndex = ordered.findIndex((part, partIndex) => partIndex >= index && isPatchLoopSpecPart(part));
    if (patchIndex < 0) {
      for (; index < ordered.length; index += 1) {
        segments.push({ type: "part", part: ordered[index] });
      }
      break;
    }

    const beatStart = findPatchBeatStart(ordered, patchIndex);
    for (; index < beatStart; index += 1) {
      segments.push({ type: "part", part: ordered[index] });
    }

    segments.push({
      type: "patch-beat",
      parts: ordered.slice(beatStart, patchIndex + 1),
    });
    index = patchIndex + 1;
  }

  return segments;
}

function findPatchBeatStart(parts: TranscriptPart[], patchIndex: number): number {
  let start = patchIndex;
  let cursor = patchIndex - 1;

  while (cursor >= 0) {
    const part = parts[cursor];
    if (part.type === "text" || part.type === "reasoning") {
      start = cursor;
      cursor -= 1;
      continue;
    }
    break;
  }

  return start;
}

function reorderTextThenToolThenThought(parts: TranscriptPart[]): TranscriptPart[] {
  const result: TranscriptPart[] = [];
  let index = 0;

  while (index < parts.length) {
    const part = parts[index];
    if (part.type !== "text") {
      result.push(part);
      index += 1;
      continue;
    }

    result.push(part);
    index += 1;

    const deferredThoughts: TranscriptPart[] = [];
    while (index < parts.length && parts[index].type === "reasoning") {
      deferredThoughts.push(parts[index]);
      index += 1;
    }

    if (index < parts.length && isToolPartType(parts[index].type)) {
      const tool = parts[index];
      if (isPatchLoopSpecPart(tool)) {
        result.push(...deferredThoughts);
        result.push(tool);
      } else {
        result.push(tool);
        result.push(...deferredThoughts);
      }
      index += 1;
      continue;
    }

    result.push(...deferredThoughts);
  }

  return result;
}

function attachLeadingReasonings(
  parts: TranscriptPart[],
  leadingReasonings: TranscriptPart[],
): TranscriptPart[] {
  const firstPatchIndex = parts.findIndex((part) => isPatchLoopSpecPart(part));
  if (firstPatchIndex >= 0) {
    const beatStart = findPatchBeatStart(parts, firstPatchIndex);
    return [
      ...parts.slice(0, beatStart),
      ...leadingReasonings,
      ...parts.slice(beatStart),
    ];
  }

  const firstToolIndex = parts.findIndex((part) => isToolPartType(part.type));
  if (firstToolIndex >= 0) {
    return [
      ...parts.slice(0, firstToolIndex + 1),
      ...leadingReasonings,
      ...parts.slice(firstToolIndex + 1),
    ];
  }

  const firstTextIndex = parts.findIndex((part) => part.type === "text");
  if (firstTextIndex >= 0) {
    return [
      ...parts.slice(0, firstTextIndex + 1),
      ...leadingReasonings,
      ...parts.slice(firstTextIndex + 1),
    ];
  }

  return [...parts, ...leadingReasonings];
}

/**
 * Dataset downloader with local file cache.
 * Datasets are cached at eval/.cache/ and only re-downloaded if missing.
 *
 * Datasets:
 *   LoCoMo   — https://huggingface.co/datasets/snap-research/locomo
 *   LongMemEval — https://huggingface.co/datasets/xiaowu0162/longmemeval
 *   BEAM (1M)   — https://huggingface.co/datasets/Mohammadta/BEAM
 *   BEAM (10M)  — https://huggingface.co/datasets/Mohammadta/BEAM-10M
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", ".cache");

export function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

export function cacheFile(name: string): string {
  return join(CACHE_DIR, name);
}

export function isCached(name: string): boolean {
  return existsSync(cacheFile(name));
}

export async function downloadFile(url: string, destName: string): Promise<string> {
  ensureCacheDir();
  const dest = cacheFile(destName);
  if (existsSync(dest)) {
    console.log(`[download] cache hit: ${destName}`);
    return dest;
  }

  console.log(`[download] fetching ${url} ...`);
  const headers: Record<string, string> = {};
  const hfToken = process.env["HF_TOKEN"];
  if (hfToken && url.includes("huggingface.co")) {
    headers["Authorization"] = `Bearer ${hfToken}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        `Download failed 401 (unauthorized): ${url}\n` +
        `  → Set HF_TOKEN=<your_token> to authenticate with HuggingFace.\n` +
        `    Get a token at https://huggingface.co/settings/tokens`
      );
    }
    throw new Error(`Download failed ${res.status}: ${url}`);
  }
  const bytes = await res.arrayBuffer();
  writeFileSync(dest, Buffer.from(bytes));
  console.log(`[download] saved ${destName} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
  return dest;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function readJsonlFile<T>(path: string): T[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

// ─── LoCoMo ───────────────────────────────────────────────────────────────────

export interface LoCoMoTurn {
  speaker: string;
  utterance: string;
  timestamp?: string;
}

export interface LoCoMoQA {
  question: string;
  answer: string;
  type?: string;
}

export interface LoCoMoDialogue {
  id: string;
  conversations: LoCoMoTurn[];
  qa: LoCoMoQA[];
}

interface RawLoCoMoSessionTurn {
  speaker?: unknown;
  text?: unknown;
  utterance?: unknown;
}

interface RawLoCoMoQuestion {
  question?: unknown;
  answer?: unknown;
  type?: unknown;
  category?: unknown;
}

interface RawLoCoMoConversationObject {
  [key: string]: unknown;
}

interface RawLoCoMoDialogue {
  id?: unknown;
  sample_id?: unknown;
  conversations?: unknown;
  conversation?: unknown;
  qa?: unknown;
}

const LOCOMO_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export async function downloadLoCoMo(): Promise<LoCoMoDialogue[]> {
  const path = await downloadFile(LOCOMO_URL, "locomo10.json");
  const raw = readJsonFile<RawLoCoMoDialogue[] | Record<string, unknown>>(path);

  const flattenToDialogues = (value: unknown): RawLoCoMoDialogue[] => {
    if (Array.isArray(value)) return value as RawLoCoMoDialogue[];
    if (value && typeof value === "object") {
      const nested = Object.values(value)
        .filter((v): v is RawLoCoMoDialogue => typeof v === "object" && v !== null);
      return nested;
    }
    return [];
  };

  const categoryToType = (category: unknown): string | undefined => {
    if (typeof category === "number" && Number.isFinite(category)) {
      return `category_${Math.trunc(category)}`;
    }
    if (typeof category === "string" && category.trim().length > 0) {
      return category.trim();
    }
    return undefined;
  };

  const normalizeTurns = (dialogue: RawLoCoMoDialogue): LoCoMoTurn[] => {
    const conv = dialogue.conversations;
    if (Array.isArray(conv)) {
      return conv
        .filter((t): t is RawLoCoMoSessionTurn => typeof t === "object" && t !== null)
        .map((t) => ({
          speaker: String(t.speaker ?? "unknown"),
          utterance: String(t.utterance ?? t.text ?? ""),
        }))
        .filter((t) => t.utterance.length > 0);
    }

    const convoObj = dialogue.conversation;
    if (!convoObj || typeof convoObj !== "object") return [];
    const obj = convoObj as RawLoCoMoConversationObject;
    const keys = Object.keys(obj)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));

    const turns: LoCoMoTurn[] = [];
    for (const key of keys) {
      const sessionTurns = obj[key];
      if (!Array.isArray(sessionTurns)) continue;
      for (const turn of sessionTurns) {
        if (!turn || typeof turn !== "object") continue;
        const t = turn as RawLoCoMoSessionTurn;
        const utterance = String(t.text ?? t.utterance ?? "");
        if (!utterance) continue;
        turns.push({
          speaker: String(t.speaker ?? "unknown"),
          utterance,
        });
      }
    }
    return turns;
  };

  const normalizeQa = (dialogue: RawLoCoMoDialogue): LoCoMoQA[] => {
    if (!Array.isArray(dialogue.qa)) return [];
    return dialogue.qa
      .filter((q): q is RawLoCoMoQuestion => typeof q === "object" && q !== null)
      .map((q) => ({
        question: String(q.question ?? "").trim(),
        answer: String(q.answer ?? "").trim(),
        type: typeof q.type === "string" && q.type.trim().length > 0
          ? q.type.trim()
          : categoryToType(q.category),
      }))
      .filter((q) => q.question.length > 0 && q.answer.length > 0);
  };

  return flattenToDialogues(raw)
    .map((dialogue, idx): LoCoMoDialogue => ({
      id: String(dialogue.id ?? dialogue.sample_id ?? `locomo-${idx + 1}`),
      conversations: normalizeTurns(dialogue),
      qa: normalizeQa(dialogue),
    }))
    .filter((dialogue) => dialogue.conversations.length > 0 && dialogue.qa.length > 0);
}

// ─── LongMemEval ──────────────────────────────────────────────────────────────

export interface LongMemEvalSession {
  role: "user" | "assistant";
  content: string;
}

export interface LongMemEvalItem {
  question_id: string;
  question: string;
  answer: string;
  evidence_session: number;
  sessions: LongMemEvalSession[][];
  question_type?: string;
}

const LONGMEMEVAL_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s_cleaned.json";

export async function downloadLongMemEval(): Promise<LongMemEvalItem[]> {
  const path = await downloadFile(LONGMEMEVAL_URL, "longmemeval_s_cleaned.json");
  return readJsonFile<LongMemEvalItem[]>(path);
}

// ─── BEAM ─────────────────────────────────────────────────────────────────────

export interface BeamNugget {
  text: string;
}

export interface BeamQuestion {
  question_id: string;
  question: string;
  answer: string;
  nuggets?: BeamNugget[];
  question_type: string;
  gold_event_order?: string[];
}

export interface BeamConversation {
  conversation_id: string;
  turns: Array<{ role: string; content: string }>;
  questions: BeamQuestion[];
}

const BEAM_1M_URL =
  "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/beam_1m.json";
const BEAM_10M_URL =
  "https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/main/beam_10m.json";

export async function downloadBeam(scale: "1m" | "10m" = "1m"): Promise<BeamConversation[]> {
  const url = scale === "10m" ? BEAM_10M_URL : BEAM_1M_URL;
  const name = scale === "10m" ? "beam_10m.json" : "beam_1m.json";
  const path = await downloadFile(url, name);
  return readJsonFile<BeamConversation[]>(path);
}

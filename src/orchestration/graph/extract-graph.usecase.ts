import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ConversationSummary } from "../ai/summarize.usecase.js";
import type { ConfidenceLabel } from "../../infrastructure/repositories/memory-graph.repository.js";

export type ExtractSource = "deterministic" | "llm";

export interface ExtractedEntity {
  label: string;
  entityType: string;
  confidence: number;
  source: ExtractSource;
  startOffset: number;
  endOffset: number;
}

export interface ExtractedRelation {
  sourceLabel: string;
  targetLabel: string;
  relationType: string;
  confidenceLabel: ConfidenceLabel;
  confidenceScore: number;
  source: ExtractSource;
}

export interface MemoryExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  llmUsed: boolean;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "into",
  "when",
  "where",
  "then",
  "been",
  "were",
  "have",
  "will",
  "your",
  "they",
  "them",
  "just",
  "like",
  "also",
  "some",
  "more",
  "most",
  "only",
  "very",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}

function entityTypeForHint(hint: string): string {
  const h = hint.toLowerCase();
  if (h.includes("project")) return "project";
  if (h.includes("tool") || h.includes("framework") || h.includes("stack") || h.includes("language")) {
    return "tool";
  }
  if (h.includes("preference") || h.includes("favorite") || h.includes("prefers") || h.includes("likes")) {
    return "preference";
  }
  if (h.includes("decision")) return "decision";
  return "topic";
}

function deterministicExtraction(memoryText: string, summary: ConversationSummary): MemoryExtractionResult {
  const source = memoryText;
  const entities: ExtractedEntity[] = [];
  const relations: ExtractedRelation[] = [];
  const seenEntities = new Set<string>();
  const seenRelations = new Set<string>();

  const addEntity = (label: string, entityType: string, confidence: number, sourceType: ExtractSource) => {
    const clean = safeLabel(label);
    const key = normalize(clean);
    if (!clean || key.length < 2 || seenEntities.has(key) || STOPWORDS.has(key)) return;
    const idx = source.toLowerCase().indexOf(clean.toLowerCase());
    entities.push({
      label: clean,
      entityType,
      confidence: clamp(confidence, 0.1, 0.99),
      source: sourceType,
      startOffset: idx >= 0 ? idx : 0,
      endOffset: idx >= 0 ? idx + clean.length : clean.length,
    });
    seenEntities.add(key);
  };

  const addRelation = (
    sourceLabel: string,
    targetLabel: string,
    relationType: string,
    confidenceLabel: ConfidenceLabel,
    confidenceScore: number,
    sourceType: ExtractSource
  ) => {
    const left = safeLabel(sourceLabel);
    const right = safeLabel(targetLabel);
    if (!left || !right || normalize(left) === normalize(right)) return;
    const key = `${normalize(left)}|${relationType}|${normalize(right)}`;
    if (seenRelations.has(key)) return;
    seenRelations.add(key);
    relations.push({
      sourceLabel: left,
      targetLabel: right,
      relationType,
      confidenceLabel,
      confidenceScore: clamp(confidenceScore, 0.1, 0.99),
      source: sourceType,
    });
  };

  const lines = [summary.title, ...summary.keyPoints, ...summary.decisions, summary.summary, source];
  const hintPattern =
    /\b(project|tool|framework|stack|language|preference|favorite|decision|goal)\b\s*[:\-]?\s*([A-Za-z][A-Za-z0-9+_.\- ]{1,40})/gi;
  for (const line of lines) {
    let match: RegExpExecArray | null;
    while ((match = hintPattern.exec(line)) !== null) {
      addEntity(match[2], entityTypeForHint(match[1]), 0.82, "deterministic");
    }
  }

  const properNounPattern = /\b[A-Z][a-zA-Z0-9+#_.-]{2,}\b/g;
  let properMatch: RegExpExecArray | null;
  while ((properMatch = properNounPattern.exec(source)) !== null) {
    addEntity(properMatch[0], "topic", 0.58, "deterministic");
    if (entities.length >= 18) break;
  }

  const verbPattern =
    /([A-Za-z][A-Za-z0-9 _+.#-]{1,40})\s+(uses|use|prefers|likes|works on|building|built|depends on|integrates with|decided on|chooses)\s+([A-Za-z][A-Za-z0-9 _+.#-]{1,40})/gi;
  const relationTypeMap: Record<string, string> = {
    uses: "uses",
    use: "uses",
    prefers: "prefers",
    likes: "prefers",
    "works on": "works_on",
    building: "builds",
    built: "builds",
    "depends on": "depends_on",
    "integrates with": "integrates_with",
    "decided on": "decided_on",
    chooses: "chooses",
  };

  let relationMatch: RegExpExecArray | null;
  while ((relationMatch = verbPattern.exec(source)) !== null) {
    const left = relationMatch[1];
    const verb = relationMatch[2].toLowerCase();
    const right = relationMatch[3];
    const relationType = relationTypeMap[verb] ?? "related_to";
    addEntity(left, "topic", 0.74, "deterministic");
    addEntity(right, "topic", 0.74, "deterministic");
    addRelation(left, right, relationType, "explicit", 0.84, "deterministic");
  }

  return { entities, relations, llmUsed: false };
}

async function llmExtraction(memoryText: string, summary: ConversationSummary): Promise<MemoryExtractionResult> {
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    messages: [
      {
        role: "system",
        content: [
          "Extract compact memory graph structure.",
          "Return JSON object with keys: entities, relations.",
          "entities: array of {label, entityType, confidence}.",
          "relations: array of {sourceLabel, targetLabel, relationType, confidenceLabel, confidenceScore}.",
          "Keep relation labels short snake_case and confidenceLabel in [explicit,inferred,uncertain].",
          "Return JSON only.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Title: ${summary.title}`,
          `Key Points: ${summary.keyPoints.join("; ")}`,
          `Decisions: ${summary.decisions.join("; ")}`,
          `Summary: ${summary.summary}`,
          `Content: ${memoryText.slice(0, 3000)}`,
        ].join("\n"),
      },
    ],
    responseFormat: "json_object",
    temperature: 0,
    maxTokens: 700,
  });

  const content = response.text ?? "";
  const parsed = JSON.parse(content) as {
    entities?: Array<{ label: string; entityType: string; confidence: number }>;
    relations?: Array<{
      sourceLabel: string;
      targetLabel: string;
      relationType: string;
      confidenceLabel: ConfidenceLabel;
      confidenceScore: number;
    }>;
  };

  const entities: ExtractedEntity[] = (parsed.entities ?? [])
    .map((item) => {
      const label = safeLabel(item.label);
      const idx = memoryText.toLowerCase().indexOf(label.toLowerCase());
      return {
        label,
        entityType: safeLabel(item.entityType || "topic").toLowerCase().replace(/\s+/g, "_"),
        confidence: clamp(item.confidence, 0.1, 0.99),
        source: "llm" as const,
        startOffset: idx >= 0 ? idx : 0,
        endOffset: idx >= 0 ? idx + label.length : label.length,
      };
    })
    .filter((item) => item.label.length > 1);

  const relations: ExtractedRelation[] = (parsed.relations ?? [])
    .map((item) => ({
      sourceLabel: safeLabel(item.sourceLabel),
      targetLabel: safeLabel(item.targetLabel),
      relationType: safeLabel(item.relationType || "related_to").toLowerCase().replace(/\s+/g, "_"),
      confidenceLabel: item.confidenceLabel,
      confidenceScore: clamp(item.confidenceScore, 0.1, 0.99),
      source: "llm" as const,
    }))
    .filter((item) => item.sourceLabel.length > 1 && item.targetLabel.length > 1);

  return { entities, relations, llmUsed: true };
}

export async function extractMemoryGraph(input: {
  memoryText: string;
  summary: ConversationSummary;
}): Promise<MemoryExtractionResult> {
  const deterministic = deterministicExtraction(input.memoryText, input.summary);
  const shouldTryLlm = deterministic.entities.length < 4 || deterministic.relations.length < 2;

  if (!shouldTryLlm) {
    return deterministic;
  }

  try {
    const llm = await llmExtraction(input.memoryText, input.summary);
    return {
      entities: [...deterministic.entities, ...llm.entities],
      relations: [...deterministic.relations, ...llm.relations],
      llmUsed: llm.llmUsed,
    };
  } catch (error) {
    if (config.nodeEnv !== "production") {
      console.warn("[graph] llm extraction failed, falling back to deterministic only", error);
    }
    return deterministic;
  }
}

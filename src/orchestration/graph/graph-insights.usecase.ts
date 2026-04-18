import type { AuthContext } from "../../domain/auth/index.js";
import { MemoryGraphRepository } from "../../infrastructure/repositories/memory-graph.repository.js";

const graphRepository = new MemoryGraphRepository();

const CONTRADICTORY_RELATION_TYPES = new Set(["prefers", "chooses", "decided_on"]);
const DECISION_RELATION_TYPES = new Set(["decided_on", "chooses", "builds", "works_on"]);
const STALE_DECISION_DAYS = 45;

export interface MemoryInsightsResult {
  generatedAt: string;
  summary: {
    contradictionCount: number;
    staleDecisionCount: number;
    highImpactCount: number;
    uncertainRelationCount: number;
  };
  contradictions: Array<{
    source: string;
    relationType: string;
    targets: Array<{ label: string; confidence: number; lastSeenAt: string }>;
    severity: "low" | "medium" | "high";
  }>;
  staleDecisions: Array<{
    source: string;
    target: string;
    relationType: string;
    daysSinceSeen: number;
    lastSeenAt: string;
    recommendation: string;
  }>;
  highImpactRelationships: Array<{
    source: string;
    target: string;
    relationType: string;
    confidence: number;
    confidenceLabel: string;
    impactScore: number;
    why: string;
  }>;
  recommendations: string[];
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function severityFromTargets(targetCount: number): "low" | "medium" | "high" {
  if (targetCount >= 3) return "high";
  if (targetCount >= 2) return "medium";
  return "low";
}

function buildRecommendations(input: {
  contradictionCount: number;
  staleDecisionCount: number;
  uncertainRelationCount: number;
  highImpactCount: number;
}): string[] {
  const result: string[] = [];
  if (input.contradictionCount > 0) {
    result.push("Review contradictory preference/decision links and save corrected facts.");
  }
  if (input.staleDecisionCount > 0) {
    result.push(`Revalidate decisions older than ${STALE_DECISION_DAYS} days to keep memory current.`);
  }
  if (input.uncertainRelationCount > 10) {
    result.push("Prioritize uncertain links for confirmation to improve graph precision.");
  }
  if (input.highImpactCount > 0) {
    result.push("Use high-impact relations as default context anchors in assistant prompts.");
  }
  if (result.length === 0) {
    result.push("No major graph risks detected. Continue monitoring confidence drift weekly.");
  }
  return result;
}

export async function getMemoryGraphInsights(auth: AuthContext): Promise<MemoryInsightsResult> {
  const entities = await graphRepository.listEntities(auth, 2000);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const entityIds = entities.map((entity) => entity.id);

  const relations = await graphRepository.listRelationsForEntityIds(auth, entityIds, 6000);
  const uncertainRelationCount = relations.filter((relation) => relation.confidence_label === "uncertain").length;

  const contradictionsMap = new Map<
    string,
    {
      sourceId: string;
      relationType: string;
      targets: Array<{ targetId: string; confidence: number; lastSeenAt: string }>;
    }
  >();
  for (const relation of relations) {
    if (!CONTRADICTORY_RELATION_TYPES.has(relation.relation_type)) continue;
    const key = `${relation.source_entity_id}:${relation.relation_type}`;
    const existing = contradictionsMap.get(key) ?? {
      sourceId: relation.source_entity_id,
      relationType: relation.relation_type,
      targets: [],
    };
    if (!existing.targets.some((target) => target.targetId === relation.target_entity_id)) {
      existing.targets.push({
        targetId: relation.target_entity_id,
        confidence: relation.confidence_score,
        lastSeenAt: relation.last_seen_at,
      });
      contradictionsMap.set(key, existing);
    }
  }

  const contradictions = [...contradictionsMap.values()]
    .filter((group) => group.targets.length > 1)
    .map((group) => {
      const source = entityById.get(group.sourceId)?.canonical_label ?? group.sourceId;
      const targets = group.targets
        .map((target) => ({
          label: entityById.get(target.targetId)?.canonical_label ?? target.targetId,
          confidence: target.confidence,
          lastSeenAt: target.lastSeenAt,
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
      return {
        source,
        relationType: group.relationType,
        targets,
        severity: severityFromTargets(group.targets.length),
      };
    })
    .sort((a, b) => b.targets.length - a.targets.length)
    .slice(0, 10);

  const staleDecisions = relations
    .filter((relation) => DECISION_RELATION_TYPES.has(relation.relation_type))
    .map((relation) => {
      const age = daysSince(relation.last_seen_at);
      return {
        relation,
        age,
      };
    })
    .filter((item) => item.age >= STALE_DECISION_DAYS)
    .sort((a, b) => b.age - a.age)
    .slice(0, 12)
    .map((item) => ({
      source: entityById.get(item.relation.source_entity_id)?.canonical_label ?? item.relation.source_entity_id,
      target: entityById.get(item.relation.target_entity_id)?.canonical_label ?? item.relation.target_entity_id,
      relationType: item.relation.relation_type,
      daysSinceSeen: item.age,
      lastSeenAt: item.relation.last_seen_at,
      recommendation: "Reconfirm whether this decision is still valid.",
    }));

  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(relation.source_entity_id, (degree.get(relation.source_entity_id) ?? 0) + 1);
    degree.set(relation.target_entity_id, (degree.get(relation.target_entity_id) ?? 0) + 1);
  }

  const highImpactRelationships = relations
    .map((relation) => {
      const degreeScore = Math.min(
        1,
        ((degree.get(relation.source_entity_id) ?? 0) + (degree.get(relation.target_entity_id) ?? 0)) / 12
      );
      const explicitBonus =
        relation.confidence_label === "explicit" ? 0.1 : relation.confidence_label === "inferred" ? 0.05 : 0;
      const impactScore = Number((relation.confidence_score * 0.6 + degreeScore * 0.3 + explicitBonus).toFixed(3));
      return {
        source: entityById.get(relation.source_entity_id)?.canonical_label ?? relation.source_entity_id,
        target: entityById.get(relation.target_entity_id)?.canonical_label ?? relation.target_entity_id,
        relationType: relation.relation_type,
        confidence: relation.confidence_score,
        confidenceLabel: relation.confidence_label,
        impactScore,
        why:
          relation.confidence_label === "explicit"
            ? "Explicit link with high graph centrality."
            : "High-confidence link touching central entities.",
      };
    })
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 12);

  const summary = {
    contradictionCount: contradictions.length,
    staleDecisionCount: staleDecisions.length,
    highImpactCount: highImpactRelationships.length,
    uncertainRelationCount,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    contradictions,
    staleDecisions,
    highImpactRelationships,
    recommendations: buildRecommendations(summary),
  };
}

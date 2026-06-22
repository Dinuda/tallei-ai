import type { AnyLoopBuildContract, GroundingSourceRef } from "../loop-engine/build-contract.js";
import { selectedGroundingSources, selectedLoopTrigger } from "../loop-engine/build-contract.js";
import { deriveRequiredConnectorActionsFromSpec } from "../loop-engine/spec-required-connectors.js";
import type { NoSlopSpec } from "../loop-engine/spec-contracts.js";
import type { LoopDefinition } from "./types.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";

type VerificationTargetRole = "critical" | "optional";
type VerificationProbeKind = "dry_run" | "visibility_only" | "trigger_check" | "grounding_probe";

export type VerificationTarget = {
  toolkit: string;
  actionSlug: string;
  role: VerificationTargetRole;
  probeKind: VerificationProbeKind;
  name?: string;
  groundingSource?: GroundingSourceRef;
};

function normalizeActionSlug(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

function selectedConnectorSlugs(contract: AnyLoopBuildContract): VerificationTarget[] {
  const requirement = contract.requirements.find((entry) => entry.kind === "connector" && entry.status === "resolved");
  const value = requirement?.value && typeof requirement.value === "object" && !Array.isArray(requirement.value)
    ? requirement.value as Record<string, unknown>
    : {};
  const selections = Array.isArray(value.selections) ? value.selections : [];
  const targets: VerificationTarget[] = [];
  for (const selection of selections) {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    const toolkit = String(record.toolkit ?? "").trim().toLowerCase();
    const slugs = Array.isArray(record.actionSlugs) ? record.actionSlugs.map(String) : [];
    for (const actionSlug of slugs) {
      targets.push({
        toolkit,
        actionSlug: normalizeActionSlug(actionSlug),
        role: "optional",
        probeKind: "dry_run",
      });
    }
  }
  return targets;
}

function specText(spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">): string {
  const agentText = (spec.agents ?? []).flatMap((agent) => [agent.goal, ...agent.doneWhen]).join(" ");
  return [
    spec.purpose,
    spec.delivery?.description ?? "",
    spec.delivery?.provider ?? "",
    agentText,
  ].join(" ").toLowerCase();
}

function specRequiresSend(spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">): boolean {
  const text = specText(spec);
  if (/\bsend\b/.test(text) && !/\bdraft only\b/.test(text) && !/\bdrafts only\b/.test(text)) return true;
  const provider = spec.delivery?.provider?.toLowerCase() ?? "";
  return provider.includes("send");
}

function isCreateDraftOrEmail(slug: string): boolean {
  const normalized = normalizeActionSlug(slug);
  return normalized.includes("CREATE") && (normalized.includes("DRAFT") || normalized.includes("EMAIL"));
}

function isSendAction(slug: string): boolean {
  return normalizeActionSlug(slug).includes("SEND");
}

function isGetDraftAction(slug: string): boolean {
  const normalized = normalizeActionSlug(slug);
  return normalized.includes("GET") && normalized.includes("DRAFT");
}

function isOptionalReadAction(slug: string): boolean {
  const normalized = normalizeActionSlug(slug);
  if (isGetDraftAction(slug)) return false;
  if (normalized.includes("LIST")) return true;
  if (normalized.includes("CONTACT")) return true;
  if (normalized.includes("SEARCH") && normalized.includes("PEOPLE")) return true;
  return normalized.includes("GET") || normalized.includes("SEARCH");
}

function classifyTarget(
  target: VerificationTarget,
  spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">,
  requiredSlugs: Set<string>,
): VerificationTarget {
  const slug = normalizeActionSlug(target.actionSlug);
  const key = `${target.toolkit.toLowerCase()}:${slug}`;
  const required = requiredSlugs.has(key);

  if (isCreateDraftOrEmail(slug)) {
    return { ...target, actionSlug: slug, role: "critical", probeKind: "dry_run" };
  }
  if (isGetDraftAction(slug)) {
    return { ...target, actionSlug: slug, role: "critical", probeKind: "dry_run" };
  }
  if (isSendAction(slug)) {
    const role = specRequiresSend(spec) || required ? "critical" : "optional";
    // Send actions are irreversible, so verification only checks that the connector
    // is available; it must not invoke the live send endpoint.
    return { ...target, actionSlug: slug, role, probeKind: "visibility_only" };
  }
  if (required) {
    return {
      ...target,
      actionSlug: slug,
      role: "critical",
      probeKind: isOptionalReadAction(slug) ? "dry_run" : "visibility_only",
    };
  }
  if (isOptionalReadAction(slug)) {
    return { ...target, actionSlug: slug, role: "optional", probeKind: "dry_run" };
  }
  return { ...target, actionSlug: slug, role: "optional", probeKind: "visibility_only" };
}

function definitionSpecBody(definition: LoopDefinition): Pick<NoSlopSpec, "purpose" | "delivery" | "agents"> {
  const children = definition.agentGraph?.children ?? [];
  if (children.length > 0) {
    return {
      purpose: definition.goal,
      delivery: {
        provider: definition.delivery?.provider ?? definition.deliveryType ?? "none",
        description: definition.delivery?.provider ?? "Dashboard only",
      },
      agents: children.map((agent) => ({
        name: agent.name,
        goal: agent.goal ?? agent.task,
        tools: (agent.tools ?? []).map((tool) => (typeof tool === "string" ? tool : tool.ref)),
        guardrails: agent.guardrails ?? [],
        doneWhen: agent.doneCriteria ?? [],
        failureModes: agent.failureModes ?? [],
        handoffBindings: agent.handoffBindings ?? [],
      })),
    };
  }

  return {
    purpose: definition.goal,
    delivery: {
      provider: definition.delivery?.provider ?? definition.deliveryType ?? "none",
      description: definition.delivery?.provider ?? "Dashboard only",
    },
    agents: [],
  };
}

export function deriveVerificationScope(input: {
  definition: LoopDefinition;
  buildContract: AnyLoopBuildContract;
}): VerificationTarget[] {
  const specBody = definitionSpecBody(input.definition);

  const requiredActions = deriveRequiredConnectorActionsFromSpec(specBody);
  const requiredSlugs = new Set(
    requiredActions.map((action) => `${action.toolkit.toLowerCase()}:${normalizeActionSlug(action.actionSlug)}`),
  );
  for (const agent of specBody.agents ?? []) {
    const doneWhen = "doneWhen" in agent && Array.isArray(agent.doneWhen) ? agent.doneWhen : [];
    const goal = `${agent.goal} ${doneWhen.join(" ")}`.toLowerCase();
    if (/\b(draft|create|send|reply|email)\b/.test(goal)) {
      // Agent goals mentioning outbound email keep create/send actions critical when selected.
      for (const target of selectedConnectorSlugs(input.buildContract)) {
        if (target.toolkit !== "gmail") continue;
        const slug = normalizeActionSlug(target.actionSlug);
        if (isCreateDraftOrEmail(slug) || isSendAction(slug) || isGetDraftAction(slug)) {
          requiredSlugs.add(`${target.toolkit}:${slug}`);
        }
      }
    }
  }

  const deliveryProvider = specBody.delivery?.provider ?? "";
  const parsedDelivery = parseConnectorActionToolRef(deliveryProvider);
  if (parsedDelivery) {
    requiredSlugs.add(`${parsedDelivery.toolkit.toLowerCase()}:${normalizeActionSlug(parsedDelivery.actionSlug)}`);
  }

  const classified = selectedConnectorSlugs(input.buildContract).map((target) =>
    classifyTarget(target, specBody, requiredSlugs));

  const trigger = selectedLoopTrigger(input.buildContract);
  if (trigger?.mode === "event") {
    classified.push({
      toolkit: trigger.toolkit,
      actionSlug: trigger.triggerSlug,
      role: "critical",
      probeKind: "trigger_check",
      name: trigger.triggerSlug,
    });
  }

  const deduped = new Map<string, VerificationTarget>();
  for (const target of classified) {
    const key = `${target.probeKind}:${target.toolkit}:${target.actionSlug}`;
    const existing = deduped.get(key);
    if (!existing || (existing.role === "optional" && target.role === "critical")) {
      deduped.set(key, target);
    }
  }
  return [...deduped.values()];
}

function groundingSourceLabel(source: GroundingSourceRef): string {
  if (source.type === "tallei_memory") return "tallei_memory";
  if (source.type === "workspace_memory") return "workspace_memory";
  return `${source.type}:${source.id}`;
}

function isWorkspaceScopedGroundingSource(source: GroundingSourceRef): boolean {
  return source.type === "workspace_memory" || source.type === "knowledge_base" || source.type === "google_doc";
}

export function deriveGroundingVerificationTargets(buildContract: AnyLoopBuildContract): VerificationTarget[] {
  const sources = selectedGroundingSources(buildContract);
  if (sources.length === 0) return [];
  return sources.map((source) => ({
    toolkit: "internal",
    actionSlug: groundingSourceLabel(source),
    role: isWorkspaceScopedGroundingSource(source) ? "critical" : "optional",
    probeKind: "grounding_probe",
    name: `Memory search (${groundingSourceLabel(source)})`,
    groundingSource: source,
  }));
}

export const VERIFICATION_RUNTIME_TRANSPARENCY_NOTES = [
  "searchWeb is not probed during verification (runtime-only).",
  "Spec agent end-to-end execution is not probed during verification (runtime-only).",
  "Connector dry-runs validate selected Composio actions and event triggers only.",
] as const;

export function selectedConnectorSlugsFromContract(contract: AnyLoopBuildContract): string[] {
  return selectedConnectorSlugs(contract).map((target) => target.actionSlug);
}

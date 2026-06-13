import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { DiscoveredToolContract } from "../tool-spec/discovery.js";
import type { NoSlopSpec } from "./spec-contracts.js";

export type SpecRequiredConnectorAction = {
  toolkit: string;
  actionSlug: string;
  risk: string;
  description?: string;
};

const SPEC_CONNECTOR_CAPABILITIES: Array<{
  toolkit: string;
  actionSlug: string;
  risk: string;
  patterns: RegExp[];
}> = [
  {
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    patterns: [
      /\b(send|deliver|broadcast|distribute|publish).{0,48}(email|newsletter|mail|inbox)\b/i,
      /\b(email|newsletter|mail).{0,48}(send|deliver|broadcast|distribute|publish)\b/i,
      /\bemail is delivered\b/i,
    ],
  },
  {
    toolkit: "googlecalendar",
    actionSlug: "GOOGLECALENDAR_CREATE_EVENT",
    risk: "write",
    patterns: [
      /\bcalendar (invite|event|meeting)\b/i,
      /\b(create|schedule|scheduling).{0,32}(calendar|invite|event|meeting)\b/i,
      /\b(google )?calendar invite\b/i,
    ],
  },
  {
    toolkit: "resend",
    actionSlug: "RESEND_SEND_EMAIL",
    risk: "send",
    patterns: [/\bresend\b/i],
  },
];

function specBehaviorText(spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">): string {
  return [
    spec.purpose,
    spec.delivery?.description,
    spec.delivery?.provider,
    ...(spec.agents ?? []).map((agent) => agent.goal),
    ...(spec.agents ?? []).flatMap((agent) => agent.doneWhen ?? []),
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
}

function actionSlugFromConnectorRef(actionSlug: string): string {
  return actionSlug.replace(/\./g, "_").toUpperCase();
}

/** Derive exact connector actions required by an approved behavioral spec. */
export function deriveRequiredConnectorActionsFromSpec(
  spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">,
): SpecRequiredConnectorAction[] {
  const text = specBehaviorText(spec);
  const actions = new Map<string, SpecRequiredConnectorAction>();

  const provider = spec.delivery?.provider?.trim() ?? "";
  if (provider && provider.toLowerCase() !== "none") {
    const parsed = parseConnectorActionToolRef(provider);
    if (parsed) {
      const key = `${parsed.toolkit}:${parsed.actionSlug}`.toLowerCase();
      actions.set(key, {
        toolkit: parsed.toolkit,
        actionSlug: actionSlugFromConnectorRef(parsed.actionSlug),
        risk: "send",
        description: spec.delivery?.description,
      });
    }
  }

  for (const capability of SPEC_CONNECTOR_CAPABILITIES) {
    if (!capability.patterns.some((pattern) => pattern.test(text))) continue;
    const key = `${capability.toolkit}:${capability.actionSlug}`.toLowerCase();
    actions.set(key, {
      toolkit: capability.toolkit,
      actionSlug: capability.actionSlug,
      risk: capability.risk,
      description: spec.delivery?.description,
    });
  }

  return [...actions.values()];
}

export function supplementDiscoveryQueriesFromSpec(
  queries: string[],
  spec: Pick<NoSlopSpec, "purpose" | "delivery" | "agents">,
): string[] {
  const required = deriveRequiredConnectorActionsFromSpec(spec);
  const supplements: string[] = [];
  for (const action of required) {
    if (action.toolkit === "gmail") supplements.push("gmail send email");
    if (action.toolkit === "googlecalendar") supplements.push("google calendar create event");
    if (action.toolkit === "resend") supplements.push("resend send email");
  }
  return [...new Set([...queries, ...supplements].map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

function toolkitFromContractRef(toolRef: string): string | null {
  return parseConnectorActionToolRef(toolRef)?.toolkit ?? null;
}

/** Keep spec-required connector contracts and drop unrelated catalogue noise from planner scope. */
export function specSemanticPipeline(
  spec: Pick<NoSlopSpec, "agents">,
): Array<{ name: string; goal: string; downstream: string }> {
  const agents = spec.agents ?? [];
  return agents.map((agent, index) => ({
    name: agent.name,
    goal: agent.goal,
    downstream: index < agents.length - 1
      ? agents[index + 1]!.name
      : "selectedActions",
  }));
}

export function prioritizeDiscoveredConnectors(
  discovered: DiscoveredToolContract[],
  requiredActions: SpecRequiredConnectorAction[],
): DiscoveredToolContract[] {
  const requiredToolkits = new Set(requiredActions.map((action) => action.toolkit.toLowerCase()));
  if (requiredToolkits.size === 0) return discovered;

  const requiredEntries = discovered.filter((entry) => {
    if (entry.source === "required_spec") return true;
    const toolkit = toolkitFromContractRef(entry.contract.toolRef);
    return toolkit ? requiredToolkits.has(toolkit.toLowerCase()) : false;
  });
  if (requiredEntries.length === 0) return discovered;
  return requiredEntries;
}

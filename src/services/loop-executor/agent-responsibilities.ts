import type { LoopAgentGraphChild, LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

export type AgentResponsibility = "approval" | "email_build" | "broadcast_delivery" | "writer" | "other";

type AgentLike = {
  id: string;
  name: string;
  task: string;
  tools: LoopToolAssignment[];
};

type NormalizeOptions = {
  newsletterDelivery: boolean;
  appendBroadcastDelivery?: boolean;
};

const APPROVAL_TOOL = "internal.email_approval_request";
const EMAIL_BUILD_TOOLS = [
  "internal.email_builder_compose",
  "internal.email_builder_render",
] as const;

const FORBIDDEN_WRITER_TOOLS = new Set<string>([
  APPROVAL_TOOL,
  ...EMAIL_BUILD_TOOLS,
  "internal.resend_broadcast",
]);

export function isNewsletterDeliveryDefinition(definition: Pick<LoopDefinition, "deliveryType" | "presetId" | "allowedToolRefs">): boolean {
  return definition.deliveryType?.trim().toLowerCase() === "newsletter"
    || definition.presetId === "newsletter"
    || definition.presetId === "newsletter_v1"
    || (definition.allowedToolRefs ?? []).some((ref) => ref.trim().toLowerCase() === "internal.resend_broadcast");
}

function toolRefs(agent: AgentLike): string[] {
  return agent.tools.map((tool) => tool.ref.trim().toLowerCase()).filter(Boolean);
}

function roleKey(agent: AgentLike): string {
  return `${agent.id} ${agent.name}`.toLowerCase();
}

function nameKey(agent: AgentLike): string {
  return agent.name.trim().toLowerCase();
}

function hasApprovalTools(agent: AgentLike): boolean {
  return toolRefs(agent).includes(APPROVAL_TOOL);
}

function hasEmailBuildTools(agent: AgentLike): boolean {
  return toolRefs(agent).some((ref) => EMAIL_BUILD_TOOLS.includes(ref as typeof EMAIL_BUILD_TOOLS[number]));
}

export function classifyAgentResponsibility(agent: AgentLike, options: Pick<NormalizeOptions, "newsletterDelivery">): AgentResponsibility {
  const refs = toolRefs(agent);
  const role = roleKey(agent);
  const name = nameKey(agent);

  if (
    options.newsletterDelivery
    && (
      refs.includes("internal.resend_broadcast")
      || name.includes("broadcast delivery")
      || (name.includes("broadcast") && name.includes("delivery"))
    )
  ) {
    return "broadcast_delivery";
  }
  if (hasEmailBuildTools(agent) || ((name.includes("email build") || name.includes("builder")) && !hasApprovalTools(agent))) {
    return "email_build";
  }
  if (hasApprovalTools(agent) || name.includes("approval")) {
    return "approval";
  }
  if (options.newsletterDelivery && (name.includes("writer") || (name.includes("write") && !name.includes("research") && !name.includes("search")) || name.includes("draft") || role.includes("writer"))) {
    return "writer";
  }
  return "other";
}

function emailBuildToolsFor(agent: AgentLike): LoopToolAssignment[] {
  const kept = agent.tools.filter((tool) => EMAIL_BUILD_TOOLS.includes(tool.ref as typeof EMAIL_BUILD_TOOLS[number]));
  if (kept.length > 0) return kept;
  return EMAIL_BUILD_TOOLS.map((ref) => ({ ref }));
}

function normalizeSingleAgent<T extends AgentLike>(agent: T, options: NormalizeOptions): T {
  const responsibility = classifyAgentResponsibility(agent, options);
  if (responsibility === "approval") {
    return {
      ...agent,
      id: agent.id || "approval",
      name: "Approval Agent",
      task: [
        "Review the producer's final draft, ask the operator any approval questions, and send the approval request only.",
        "Do not compose/render email, upload contacts, sync recipients, submit a Resend broadcast, or send the subscriber broadcast.",
      ].join(" "),
      tools: [{ ref: APPROVAL_TOOL }],
    };
  }
  if (responsibility === "email_build") {
    return {
      ...agent,
      id: agent.id || "email_build",
      name: "Email Build Agent",
      task: [
        "Compose and render the visual email from the writer draft only.",
        "Do not send approval requests, upload contacts, sync recipients, or submit a Resend broadcast.",
      ].join(" "),
      tools: emailBuildToolsFor(agent),
    };
  }
  if (responsibility === "broadcast_delivery") {
    return {
      ...agent,
      id: agent.id || "broadcast_delivery",
      name: "Broadcast Delivery Agent",
      task: [
        "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
        "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
      ].join(" "),
      tools: [{ ref: "internal.resend_broadcast" }],
    };
  }
  if (responsibility === "writer") {
    const allowedTools = agent.tools.filter((tool) => !FORBIDDEN_WRITER_TOOLS.has(tool.ref));
    return {
      ...agent,
      name: /newsletter/i.test(agent.name) ? agent.name : "Newsletter Writer",
      task: agent.task.trim() || [
        "Write one subscriber-ready newsletter draft only, grounded in prior research and verified facts.",
        "Do not ask approval questions, prepare email builder output, upload contacts, or send/broadcast anything.",
      ].join(" "),
      tools: allowedTools.length > 0 ? allowedTools : [{ ref: "internal.llm_only" }],
    };
  }
  return agent;
}

function splitMixedApprovalBuildAgent<T extends AgentLike>(agent: T, options: NormalizeOptions): T[] {
  if (!hasApprovalTools(agent) || !hasEmailBuildTools(agent)) {
    return [agent];
  }
  return [
    {
      ...agent,
      id: `${agent.id}_email_build`.replace(/_email_build_email_build$/, "_email_build"),
      name: "Email Build Agent",
      tools: agent.tools.filter((tool) => EMAIL_BUILD_TOOLS.includes(tool.ref as typeof EMAIL_BUILD_TOOLS[number])),
    },
    {
      ...agent,
      id: `${agent.id}_approval`.replace(/_approval_approval$/, "_approval"),
      name: "Approval Agent",
      tools: [{ ref: APPROVAL_TOOL }],
    },
  ];
}

function isSpecialDeliveryTool(ref: string): boolean {
  const normalized = ref.trim().toLowerCase();
  return normalized === APPROVAL_TOOL
    || EMAIL_BUILD_TOOLS.includes(normalized as typeof EMAIL_BUILD_TOOLS[number])
    || normalized === "internal.resend_broadcast";
}

function explodeCompoundAgents<T extends AgentLike>(agents: T[], options: NormalizeOptions): T[] {
  return agents.flatMap((agent) => {
    const refs = toolRefs(agent);
    const hasBroadcast = options.newsletterDelivery && refs.includes("internal.resend_broadcast");
    const hasApproval = hasApprovalTools(agent);
    const hasBuild = hasEmailBuildTools(agent);
    const specialFlags = [hasBroadcast, hasApproval, hasBuild].filter(Boolean).length;
    if (specialFlags <= 1) {
      return splitMixedApprovalBuildAgent(agent, options);
    }

    const parts: T[] = [];
    const remainder = agent.tools.filter((tool) => !isSpecialDeliveryTool(tool.ref));
    if (remainder.length > 0) {
      parts.push({ ...agent, tools: remainder });
    }
    if (hasBuild) {
      parts.push({
        ...agent,
        id: `${agent.id}_email_build`,
        name: "Email Build Agent",
        tools: agent.tools.filter((tool) => EMAIL_BUILD_TOOLS.includes(tool.ref as typeof EMAIL_BUILD_TOOLS[number])),
      });
    }
    if (hasApproval) {
      parts.push({
        ...agent,
        id: `${agent.id}_approval`,
        name: "Approval Agent",
        tools: [{ ref: APPROVAL_TOOL }],
      });
    }
    if (hasBroadcast) {
      parts.push({
        ...agent,
        id: `${agent.id}_broadcast`,
        name: "Broadcast Delivery Agent",
        tools: [{ ref: "internal.resend_broadcast" }],
      });
    }
    return parts.flatMap((part) => splitMixedApprovalBuildAgent(part, options));
  });
}

function responsibilityOrder(responsibility: AgentResponsibility): number {
  switch (responsibility) {
    case "other": return 0;
    case "writer": return 1;
    case "email_build": return 2;
    case "approval": return 3;
    case "broadcast_delivery": return 4;
    default: return 0;
  }
}

export function normalizeAgentResponsibilities<T extends AgentLike>(agents: T[], options: NormalizeOptions): T[] {
  const expanded = explodeCompoundAgents(agents, options);
  const normalized = expanded.map((agent) => normalizeSingleAgent(agent, options));
  const responsibilities = normalized.map((agent) => classifyAgentResponsibility(agent, options));
  const keepIndexes = new Set<number>(normalized.map((_, index) => index));

  const collapseResponsibility = (responsibility: AgentResponsibility, keep: "first" | "last") => {
    const indexes = responsibilities
      .map((value, index) => value === responsibility ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length <= 1) return;
    const keepIndex = keep === "first" ? indexes[0] : indexes[indexes.length - 1];
    for (const index of indexes) {
      if (index !== keepIndex) keepIndexes.delete(index);
    }
  };

  collapseResponsibility("writer", "last");
  collapseResponsibility("email_build", "first");
  collapseResponsibility("approval", "first");
  collapseResponsibility("broadcast_delivery", "first");

  const deduped = normalized
    .filter((_, index) => keepIndexes.has(index))
    .sort((left, right) => {
      const leftOrder = responsibilityOrder(classifyAgentResponsibility(left, options));
      const rightOrder = responsibilityOrder(classifyAgentResponsibility(right, options));
      return leftOrder - rightOrder;
    });

  const hasBroadcast = deduped.some((agent) => classifyAgentResponsibility(agent, options) === "broadcast_delivery");
  if (options.newsletterDelivery && options.appendBroadcastDelivery !== false && !hasBroadcast) {
    deduped.push({
      id: "broadcast_delivery",
      name: "Broadcast Delivery Agent",
      task: [
        "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
        "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
      ].join(" "),
      tools: [{ ref: "internal.resend_broadcast" }],
    } as T);
  }
  return deduped;
}

export function normalizeGraphResponsibilities(
  children: LoopAgentGraphChild[],
  options: NormalizeOptions,
): LoopAgentGraphChild[] {
  return normalizeAgentResponsibilities(children, options);
}

export function normalizeRunAgentResponsibilities(
  agents: LoopRunAgent[],
  options: NormalizeOptions,
): LoopRunAgent[] {
  return normalizeAgentResponsibilities(agents, options);
}

export function isBroadcastDeliveryAgent(agent: AgentLike, newsletterDelivery = true): boolean {
  return classifyAgentResponsibility(agent, { newsletterDelivery }) === "broadcast_delivery";
}

export function isApprovalAgent(agent: AgentLike, newsletterDelivery = true): boolean {
  return classifyAgentResponsibility(agent, { newsletterDelivery }) === "approval";
}

export function isEmailBuildAgent(agent: AgentLike, newsletterDelivery = true): boolean {
  return classifyAgentResponsibility(agent, { newsletterDelivery }) === "email_build";
}

import {
  loopDefinitionSchema,
  type LoopDefinition,
  type LoopRunAgent,
} from "../loop-executor/types.js";

function policyToolRef(policy: { toolkit: string; actionSlug: string }): string {
  return `composio.${policy.toolkit.toLowerCase()}.action.${policy.actionSlug.toLowerCase()}`;
}

function isConnectorActionTool(ref: string): boolean {
  return /^composio\.[a-z0-9_-]+\.action\./i.test(ref);
}

function approvedWriteRefs(definition: LoopDefinition): Set<string> {
  const refs = new Set(
    (definition.connectorPolicy?.allowedWriteActions ?? []).map(policyToolRef),
  );
  const provider = definition.delivery?.provider?.trim().toLowerCase();
  if (provider && isConnectorActionTool(provider)) {
    refs.add(provider);
  }
  for (const child of definition.agentGraph?.children ?? []) {
    for (const tool of child.tools) {
      if (isConnectorActionTool(tool.ref)) {
        refs.add(tool.ref.toLowerCase());
      }
    }
  }
  return refs;
}

function agentHasApprovedWrite(agent: LoopRunAgent, refs: Set<string>): boolean {
  return agent.tools.some((tool) => refs.has(tool.ref.toLowerCase()));
}

function shouldUseDraftReviewGate(agent: LoopRunAgent): boolean {
  const primaryTool = agent.tools[0]?.ref?.toLowerCase() ?? "";
  return primaryTool === "internal.llm_only"
    || agent.renderTarget === "canvas.email"
    || agent.renderTarget === "canvas.preview";
}

function draftReviewQuestion(agent: LoopRunAgent): string {
  const question = agent.gate?.question?.trim();
  if (question && !/\b(send|broadcast|deliver|subscriber)\b/i.test(question)) {
    return question;
  }
  return "Review this draft before proceeding.";
}

function isOrphanQaAgent(agent: LoopRunAgent): boolean {
  const label = `${agent.id} ${agent.name ?? ""} ${agent.goal ?? ""} ${agent.task ?? ""}`.toLowerCase();
  return /\b(approval|qa|review)\b/i.test(label)
    && (agent.tools[0]?.ref ?? "") === "internal.llm_only"
    && !agent.renderTarget;
}

function isWebSearchAgent(agent: LoopRunAgent): boolean {
  const tool = agent.tools[0]?.ref ?? "";
  return tool === "internal.web_search" || /^composio\.[a-z0-9_-]+\.search$/i.test(tool);
}

/** Fix common architect gate mismatches before runtime validation. */
export function normalizeLoopDefinitionForRuntime(definition: LoopDefinition): LoopDefinition {
  const parsed = loopDefinitionSchema.parse(definition);
  const writeRefs = approvedWriteRefs(parsed);
  const hasOutboundDelivery = parsed.delivery?.target !== "none"
    && (parsed.delivery?.provider?.trim().toLowerCase() ?? "none") !== "none";

  let children = (parsed.agentGraph?.children ?? []).filter((agent) => !isOrphanQaAgent(agent));

  children = children.map((agent) => {
    const hasApprovedWrite = agentHasApprovedWrite(agent, writeRefs);

    if (agent.gate?.type === "pre_send" && !hasApprovedWrite) {
      if (shouldUseDraftReviewGate(agent)) {
        return {
          ...agent,
          renderTarget: agent.renderTarget ?? "canvas.email",
          gate: {
            type: "draft_review" as const,
            question: draftReviewQuestion(agent),
          },
        };
      }
      if (!hasOutboundDelivery) {
        const { gate: _gate, ...withoutGate } = agent;
        return withoutGate;
      }
    }

    if (isWebSearchAgent(agent) && agent.gate?.type !== "source_confirmation") {
      return {
        ...agent,
        gate: {
          type: "source_confirmation" as const,
          question: agent.gate?.question ?? "Select which sources to include. Add custom URLs if needed.",
        },
      };
    }

    if (shouldUseDraftReviewGate(agent) && agent.gate?.type !== "draft_review" && agent.gate?.type !== "pre_send") {
      return {
        ...agent,
        renderTarget: agent.renderTarget ?? "canvas.email",
        gate: {
          type: "draft_review" as const,
          question: draftReviewQuestion(agent),
        },
      };
    }

    return agent;
  });

  return loopDefinitionSchema.parse({
    ...parsed,
    agentGraph: parsed.agentGraph
      ? { ...parsed.agentGraph, children }
      : parsed.agentGraph,
  });
}

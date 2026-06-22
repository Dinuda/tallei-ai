import type { DataContract } from "../loop-engine/data-contract.js";
import type { NoSlopSpecAgent } from "../loop-engine/spec-contracts.js";
import type { LoopDefinition } from "../loop-executor/types.js";

export type AgentContractRole = "source_evidence" | "draft_body" | "final_preview" | "delivery";

export function evidenceOutputContract(): DataContract {
  return {
    description: "Structured evidence and context for downstream agents.",
    representation: "json",
    mediaType: "application/json",
    visibility: "internal",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ticket_found", "no_tickets_found"] },
        summary: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        ticket: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body: { type: "string" },
            threadId: { type: "string" },
            messageId: { type: "string" },
          },
          required: ["subject", "body"],
          additionalProperties: true,
        },
        customer: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          additionalProperties: true,
        },
        findings: { type: "array", items: { type: "string" } },
        context: { type: "object", additionalProperties: true },
      },
      required: ["summary", "status"],
      allOf: [{
        if: {
          properties: { status: { const: "ticket_found" } },
          required: ["status"],
        },
        then: { required: ["ticket"] },
      }],
      additionalProperties: true,
    },
  };
}

export function draftOutputContract(renderer: "canvas.email" | "canvas.preview"): DataContract {
  if (renderer === "canvas.email") {
    return {
      description: "Operator-reviewable email draft matching the approved artifact contract, or an explicit no-action status when there is no support ticket to draft for.",
      representation: "json",
      mediaType: "application/json",
      visibility: "operator",
      renderer: "canvas.email",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft_ready", "no_action_required"] },
          subject: { type: "string" },
          body: { type: "string" },
          html: { type: "string" },
          summary: { type: "string" },
        },
        required: ["status"],
        additionalProperties: false,
      },
    };
  }
  return {
    description: "Operator-reviewable preview artifact, or an explicit no-action status when there is nothing actionable to preview.",
    representation: "json",
    mediaType: "application/json",
    visibility: "operator",
    renderer: "canvas.preview",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["preview_ready", "no_action_required"] },
        title: { type: "string" },
        body: { type: "string" },
        summary: { type: "string" },
      },
      required: ["status"],
      additionalProperties: true,
    },
  };
}

export function deliveryOutputContract(): DataContract {
  return {
    description: "Delivery package ready for operator approval.",
    representation: "json",
    mediaType: "application/json",
    visibility: "operator",
    schema: {
      type: "object",
      properties: {
        ready: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["ready", "summary"],
      additionalProperties: true,
    },
  };
}

export function catalogInputContract(description: string): DataContract {
  return {
    description,
    representation: "json",
    schema: { type: "object", properties: {}, additionalProperties: true },
  };
}

function draftRendererFromArtifactKind(kind: string | undefined): "canvas.email" | "canvas.preview" | null {
  if (kind === "canvas_email") return "canvas.email";
  if (kind === "canvas_preview") return "canvas.preview";
  return null;
}

type AgentContractSource = {
  name: string;
  goal?: string;
  task?: string;
  artifactRole?: AgentContractRole;
  inputContract?: NoSlopSpecAgent["inputContract"];
  outputContract?: DataContract;
  outputArtifactKind?: string;
  doneCriteria?: string[];
  doneWhen?: string[];
};

export function resolveAgentOutputContract(agent: AgentContractSource): DataContract | undefined {
  if (agent.outputContract) return agent.outputContract;

  const renderer = draftRendererFromArtifactKind(agent.outputArtifactKind);
  if (agent.artifactRole === "source_evidence") return evidenceOutputContract();
  if (agent.artifactRole === "draft_body" || agent.artifactRole === "final_preview") {
    return draftOutputContract(renderer ?? "canvas.preview");
  }
  if (agent.artifactRole === "delivery") return deliveryOutputContract();
  return undefined;
}

export function resolveAgentInputContract(agent: AgentContractSource): NonNullable<NoSlopSpecAgent["inputContract"]> {
  if (agent.inputContract) return agent.inputContract;
  return catalogInputContract(`Runtime input for ${agent.name}.`);
}

export function defaultHandoffBinding(agentId: string, targetPath = "/") {
  return {
    source: { kind: "agent_output" as const, agentId, path: "/" },
    targetPath,
    required: true,
    valuePolicy: "derivable" as const,
    provenance: "agent_output" as const,
    transformation: "direct" as const,
  };
}

export const ROLE_AGENT_DEFAULTS: Record<AgentContractRole, {
  guardrails: string[];
  doneCriteria: string[];
  failureModes: string[];
}> = {
  source_evidence: {
    guardrails: ["Use only approved read and search tools.", "Do not draft or send outbound messages."],
    doneCriteria: ["Evidence matches the intake output contract."],
    failureModes: ["Pause for operator input when required context is missing."],
  },
  draft_body: {
    guardrails: ["Use finalizeAgent output that matches the declared output contract.", "Do not send or publish directly unless this agent owns delivery tools."],
    doneCriteria: ["Output is ready for operator review or downstream delivery, unless status is no_action_required."],
    failureModes: ["Pause when required upstream evidence is missing."],
  },
  final_preview: {
    guardrails: ["Use finalizeAgent output that matches the declared output contract.", "Do not send or publish directly unless this agent owns delivery tools."],
    doneCriteria: ["Output is ready for operator review or downstream delivery, unless status is no_action_required."],
    failureModes: ["Pause when required upstream evidence is missing."],
  },
  delivery: {
    guardrails: ["Use requestGate type=action before any mutating external action.", "Do not execute mutating connector actions without operator approval."],
    doneCriteria: ["Delivery output matches the declared contract."],
    failureModes: ["Pause when upstream draft or approval is missing."],
  },
};

export function expandAgentGraphChild(
  agent: LoopDefinition["agentGraph"]["children"][number],
): LoopDefinition["agentGraph"]["children"][number] {
  const roleDefaults = agent.artifactRole ? ROLE_AGENT_DEFAULTS[agent.artifactRole] : null;
  const outputContract = resolveAgentOutputContract(agent);
  const inputContract = agent.inputContract ?? (outputContract ? catalogInputContract(`Runtime input for ${agent.name}.`) : undefined);
  const handoffBindings = (agent.handoffBindings ?? []).map((binding) => ({
    source: {
      kind: binding.source.kind,
      ...(binding.source.agentId ? { agentId: binding.source.agentId } : {}),
      ...(binding.source.key ? { key: binding.source.key } : {}),
      path: binding.source.path ?? "/",
    },
    targetPath: binding.targetPath,
    required: binding.required ?? true,
    ...(binding.valuePolicy ? { valuePolicy: binding.valuePolicy } : {}),
    ...(binding.provenance ? { provenance: binding.provenance } : {}),
    transformation: binding.transformation ?? "direct",
  }));

  return {
    ...agent,
    guardrails: agent.guardrails ?? roleDefaults?.guardrails ?? [],
    doneCriteria: agent.doneCriteria ?? roleDefaults?.doneCriteria ?? [],
    failureModes: agent.failureModes ?? roleDefaults?.failureModes ?? [],
    ...(inputContract ? { inputContract } : {}),
    ...(outputContract ? { outputContract } : {}),
    handoffBindings,
    outputArtifactId: agent.outputArtifactId ?? `${agent.id}_output`,
    ...(agent.outputArtifactKind || outputContract
      ? {
          outputArtifactKind: agent.outputArtifactKind
            ?? (outputContract?.renderer === "canvas.preview"
              ? "canvas_preview"
              : outputContract?.renderer === "canvas.email"
                ? "canvas_email"
                : "structured_output"),
        }
      : {}),
  };
}

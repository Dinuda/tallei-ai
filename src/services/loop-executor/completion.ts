/**
 * completion.ts — Determines whether an agent task is truly complete.
 *
 * The executor should not advance because an agent returned text. It advances
 * only when the agent's result satisfies the role's completion contract.
 */

import { approvalArtifactBlocker } from "./approval.js";
import { classifyAgentResponsibility, isNewsletterDeliveryDefinition } from "./agent-responsibilities.js";
import type { RunLoopAgentResult } from "./agent-runner.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

export type CompletionCheckResult = {
  done: boolean;
  reason: string;
  criteria: string[];
};

function refs(tools: LoopToolAssignment[]): string[] {
  return tools.map((tool) => tool.ref.trim().toLowerCase()).filter(Boolean);
}

function compactCriteria(agent: LoopRunAgent, fallback: string[]): string[] {
  const explicit = (agent.doneCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean);
  return explicit.length > 0 ? explicit : fallback;
}

function missingInputBlocker(text: string): string | null {
  const blocker = approvalArtifactBlocker(text);
  if (blocker) return blocker;

  const normalized = text.trim().toLowerCase();
  const asksForInput = /\b(please paste|paste|send|share|provide)\b[\s\S]{0,160}\b(sprint notes?|product updates?|core data|required data|missing details?|past updates?)\b/.test(normalized);
  const cannotProduce = /\b(can't|cannot|can not|unable to|not enough|missing)\b[\s\S]{0,120}\b(draft|generate|write|create|core data|sprint notes?|product updates?)\b/.test(normalized);
  if (asksForInput && cannotProduce) {
    return "Stage blocked: required input is missing. Provide the requested notes/data, then rerun this stage.";
  }
  return null;
}

function taskRequiresEmailDraft(agent: LoopRunAgent): boolean {
  return /\b(email|newsletter|subject:|preview:|shipped this week|going out to customers)\b/i.test(`${agent.name} ${agent.task}`);
}

function hasEmailShape(text: string): boolean {
  return /^subject\s*:/im.test(text)
    || /\b(shipped this week|in progress|things to watch|going out to customers|next week)\b/i.test(text);
}

export function evaluateAgentCompletion(input: {
  agent: LoopRunAgent;
  assignedTools: LoopToolAssignment[];
  result: RunLoopAgentResult;
  definition: LoopDefinition;
}): CompletionCheckResult {
  const toolRefs = refs(input.assignedTools);
  const text = input.result.text.trim();
  const responsibility = classifyAgentResponsibility(input.agent, {
    newsletterDelivery: isNewsletterDeliveryDefinition(input.definition),
  });

  if (!text) {
    return {
      done: false,
      reason: "Stage did not produce any output.",
      criteria: compactCriteria(input.agent, ["Agent returns a non-empty output."]),
    };
  }

  if (responsibility === "approval" || toolRefs.includes("internal.email_approval_request")) {
    const criteria = compactCriteria(input.agent, [
      "Approval request was sent or already reserved.",
      "Approval artifact is a real draft, not a missing-input placeholder.",
    ]);
    if (!input.result.emailApprovalSent || !input.result.approvalRequest?.token || !input.result.approvalRequest?.approvalUrl) {
      return { done: false, reason: "Approval request was not sent.", criteria };
    }
    const artifactBody = input.result.artifactBody?.trim() ?? "";
    const blocker = missingInputBlocker(artifactBody);
    if (blocker) return { done: false, reason: blocker, criteria };
    return { done: true, reason: "Approval request sent.", criteria };
  }

  if (responsibility === "email_build" || toolRefs.some((ref) => ref === "internal.email_builder_compose" || ref === "internal.email_builder_render")) {
    const criteria = compactCriteria(input.agent, [
      "Email HTML template is rendered.",
      "Rendered template is based on an upstream writer draft.",
    ]);
    if (!input.result.emailTemplate?.html?.trim()) {
      return { done: false, reason: "Email build did not produce rendered HTML.", criteria };
    }
    return { done: true, reason: "Email template rendered.", criteria };
  }

  if (responsibility === "writer" || /\b(write|writer|draft)\b/i.test(`${input.agent.id} ${input.agent.name}`)) {
    const criteria = compactCriteria(input.agent, [
      "Writer returns the requested final deliverable.",
      "Writer output is not a missing-input request or placeholder.",
    ]);
    const blocker = missingInputBlocker(text);
    if (blocker) return { done: false, reason: blocker, criteria };
    if (taskRequiresEmailDraft(input.agent) && !hasEmailShape(text)) {
      return { done: false, reason: "Writer output does not look like the requested email draft.", criteria };
    }
    return { done: true, reason: "Writer produced final deliverable.", criteria };
  }

  if (responsibility === "broadcast_delivery" || toolRefs.includes("internal.resend_broadcast")) {
    return {
      done: false,
      reason: "Broadcast delivery cannot complete in the normal agent runner. It must run through the post-approval delivery heartbeat.",
      criteria: compactCriteria(input.agent, [
        "Operator approval is complete.",
        "Recipients are uploaded.",
        "Broadcast delivery heartbeat submits the send and records provider result.",
      ]),
    };
  }

  if (responsibility === "channel_delivery" || toolRefs.includes("composio.gmail.send_email")) {
    const criteria = compactCriteria(input.agent, [
      "Operator approval is complete.",
      "Channel delivery tool has a concrete recipient, subject, and body.",
      "Send result is recorded.",
    ]);
    const data = input.result.data ?? {};
    const hasSendResult = data.deliverySent === true
      || data.sent === true
      || typeof data.messageId === "string"
      || typeof data.providerMessageId === "string";
    if (!hasSendResult) {
      return { done: false, reason: "Channel delivery did not record a send result.", criteria };
    }
    return { done: true, reason: "Channel delivery sent and recorded a result.", criteria };
  }

  return {
    done: true,
    reason: "Generic stage produced output.",
    criteria: compactCriteria(input.agent, ["Agent returns a non-empty output relevant to its assigned task."]),
  };
}

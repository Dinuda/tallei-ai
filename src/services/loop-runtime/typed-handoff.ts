import type { AgentHandoffBinding, LoopRunAgent } from "../loop-executor/types.js";
import { deriveSubjectFromBody } from "./email-canvas.js";

type HandoffResolution = {
  value: Record<string, unknown>;
  resolvedBindings: Array<{ binding: AgentHandoffBinding; resolved: boolean; provenanceValid: boolean }>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === "/") return value;
  return path.split("/").filter(Boolean).reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      return Number.isFinite(index) ? current[index] : undefined;
    }
    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (path === "/") return asObject(value);
  const segments = path.split("/").filter(Boolean);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    current[segment] = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    current = current[segment] as Record<string, unknown>;
  }
  if (segments.length > 0) current[segments.at(-1)!] = value;
  return target;
}

function normalizeEmailStructuredOutput(value: Record<string, unknown>): Record<string, unknown> {
  const body = typeof value.body === "string" ? value.body.trim()
    : typeof value.text === "string" ? value.text.trim() : "";
  let subject = typeof value.subject === "string" ? value.subject.trim() : "";
  if (body && !subject) subject = deriveSubjectFromBody(body);
  return {
    ...value,
    ...(body ? { body } : {}),
    ...(subject ? { subject } : {}),
  };
}

function structuredAgentOutput(raw: unknown): unknown {
  const artifact = asObject(raw);
  const data = asObject(artifact.data);
  const nestedData = asObject(data.data);

  let candidate: Record<string, unknown> | null = null;
  if (nestedData.structuredOutput && typeof nestedData.structuredOutput === "object" && !Array.isArray(nestedData.structuredOutput)) {
    candidate = asObject(nestedData.structuredOutput);
  } else if (data.structuredOutput && typeof data.structuredOutput === "object" && !Array.isArray(data.structuredOutput)) {
    candidate = asObject(data.structuredOutput);
  } else if (artifact.structuredOutput && typeof artifact.structuredOutput === "object" && !Array.isArray(artifact.structuredOutput)) {
    candidate = asObject(artifact.structuredOutput);
  }

  const envelopeValue = asObject(asObject(data.artifactEnvelope).value);
  if (!candidate && Object.keys(envelopeValue).length > 0) candidate = envelopeValue;

  const emailTemplate = asObject(data.emailTemplate);
  if (!candidate && (emailTemplate.subject || emailTemplate.text || emailTemplate.html)) {
    const body = typeof emailTemplate.text === "string" && emailTemplate.text.trim()
      ? emailTemplate.text.trim()
      : typeof emailTemplate.html === "string" ? emailTemplate.html : "";
    const subject = typeof emailTemplate.subject === "string" ? emailTemplate.subject.trim() : "";
    candidate = { subject, body };
  }

  if (!candidate && typeof data.text === "string" && data.text.trim()) {
    candidate = { body: data.text.trim() };
  }

  if (!candidate) return artifact;
  return normalizeEmailStructuredOutput(candidate);
}

/**
 * Pulls the structured output ({ subject, body, ... }) out of a raw, un-compacted
 * artifact data_json so it can be attached to the handoff envelope before
 * `compactArtifactData` truncates large payloads. Without this, long emails lose
 * their structured fields to truncation and downstream connector bindings such as
 * gmail_send_email's /subject can no longer be resolved.
 */
export function extractStructuredOutputFromArtifact(rawDataJson: unknown, body?: string): Record<string, unknown> | undefined {
  const data = asObject(rawDataJson);
  const nestedData = asObject(data.data);
  const candidates: unknown[] = [
    asObject(nestedData.data).structuredOutput,
    nestedData.structuredOutput,
    data.structuredOutput,
    asObject(data.artifactEnvelope).value,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.keys(candidate).length > 0) {
      return normalizeEmailStructuredOutput(candidate as Record<string, unknown>);
    }
  }

  const emailTemplate = asObject(data.emailTemplate);
  if (emailTemplate.subject || emailTemplate.text || emailTemplate.html) {
    const tplBody = typeof emailTemplate.text === "string" && emailTemplate.text.trim()
      ? emailTemplate.text.trim()
      : typeof emailTemplate.html === "string" ? emailTemplate.html : "";
    const subject = typeof emailTemplate.subject === "string" ? emailTemplate.subject.trim() : "";
    return normalizeEmailStructuredOutput({ subject, body: tplBody });
  }

  if (typeof body === "string" && body.trim()) {
    const trimmed = body.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (("subject" in parsed) || ("body" in parsed) || ("text" in parsed))) {
        return normalizeEmailStructuredOutput(parsed as Record<string, unknown>);
      }
    } catch {
      // body is not JSON; fall through to plain-text body
    }
    return normalizeEmailStructuredOutput({ body: trimmed });
  }

  if (typeof data.text === "string" && data.text.trim()) {
    return normalizeEmailStructuredOutput({ body: data.text.trim() });
  }
  return undefined;
}

export function buildPriorOutputIndex(input: {
  artifacts: Array<{
    artifact_key: string;
    agent_id: string;
    envelope: Record<string, unknown>;
  }>;
  children?: Array<{ id: string; outputArtifactId?: string }>;
}): Record<string, unknown> {
  const artifactIdToAgentId = new Map(
    (input.children ?? []).flatMap((child) =>
      child.outputArtifactId ? [[child.outputArtifactId, child.id] as const] : []),
  );
  const indexed: Record<string, unknown> = {};
  for (const row of input.artifacts) {
    indexed[row.artifact_key] = row.envelope;
    indexed[`${row.agent_id}_output`] = row.envelope;
    const mappedAgentId = artifactIdToAgentId.get(row.artifact_key);
    if (mappedAgentId) indexed[`${mappedAgentId}_output`] = row.envelope;
  }
  return indexed;
}

export function resolveAgentHandoffBindings(input: {
  agent: Pick<LoopRunAgent, "handoffBindings">;
  priorOutputs: Record<string, unknown>;
  operatorInputs: Record<string, unknown>;
  stableConfig?: Record<string, unknown>;
}): HandoffResolution {
  let value: Record<string, unknown> = {};
  const resolvedBindings: HandoffResolution["resolvedBindings"] = [];
  for (const binding of input.agent.handoffBindings) {
    let source: unknown;
    if (binding.source.kind === "agent_output" && binding.source.agentId) {
      source = structuredAgentOutput(input.priorOutputs[`${binding.source.agentId}_output`]
        ?? input.priorOutputs[binding.source.agentId]);
    } else if (binding.source.kind === "operator_input" && binding.source.key) {
      source = input.operatorInputs[binding.source.key];
    } else if (binding.source.kind === "stable_config") {
      source = input.stableConfig ?? {};
    } else if (binding.source.kind === "artifact" && binding.source.key) {
      source = input.priorOutputs[binding.source.key];
    }
    const selected = valueAtPath(source, binding.source.path);
    const resolved = selected !== undefined && selected !== null;
    const expectedProvenance = binding.source.kind === "agent_output"
      ? "agent_output"
      : binding.source.kind;
    const provenanceValid = !binding.provenance
      || binding.provenance === expectedProvenance
      || (binding.provenance === "connector_output" && binding.source.kind === "agent_output");
    resolvedBindings.push({ binding, resolved, provenanceValid });
    if (resolved) value = setAtPath(value, binding.targetPath, selected);
  }
  return { value, resolvedBindings };
}

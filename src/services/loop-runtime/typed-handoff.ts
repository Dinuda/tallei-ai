type HandoffBinding = {
  source: {
    kind: "agent_output" | "operator_input" | "stable_config" | "artifact" | string;
    agentId?: string;
    key?: string;
    path: string;
  };
  targetPath: string;
  required: boolean;
};

type PriorOutputIndex = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function pointerSegments(path: string): string[] {
  const normalized = path.trim() || "/";
  if (normalized === "/") return [];
  return normalized
    .replace(/^#/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of pointerSegments(path)) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else {
      return undefined;
    }
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(target, value);
    return;
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

function titleFromMarkdown(body: string): string | null {
  const heading = body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.replace(/^#+\s*/, "").slice(0, 120) : null;
}

function bodyFromStructuredOutput(value: Record<string, unknown>, fallbackBody?: string): Record<string, unknown> {
  const record = { ...value };
  const emailTemplate = asRecord(record.emailTemplate);
  if (!isPresent(record.subject) && typeof emailTemplate.subject === "string") record.subject = emailTemplate.subject;
  if (!isPresent(record.body)) {
    if (typeof emailTemplate.text === "string") record.body = emailTemplate.text;
    else if (typeof record.text === "string") record.body = record.text;
    else if (typeof fallbackBody === "string" && fallbackBody.trim()) record.body = fallbackBody;
  }
  if (!isPresent(record.subject) && typeof record.body === "string") {
    const title = titleFromMarkdown(record.body);
    if (title) record.subject = title;
  }
  return record;
}

export function extractStructuredOutputFromArtifact(dataJson: unknown, body?: string): Record<string, unknown> | null {
  const data = asRecord(dataJson);
  const candidates = [
    data.structuredOutput,
    asRecord(data.data).structuredOutput,
    asRecord(asRecord(data.data).data).structuredOutput,
    asRecord(data.artifactEnvelope).value,
    data.data,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return bodyFromStructuredOutput(candidate as Record<string, unknown>, body);
    }
  }
  if (typeof body === "string" && body.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return bodyFromStructuredOutput(parsed as Record<string, unknown>, body);
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function buildPriorOutputIndex(input: {
  artifacts: Array<{ artifact_key: string; agent_id?: string; body?: string; envelope: unknown }>;
  children: Array<{ id: string; outputArtifactId?: string }>;
}): PriorOutputIndex {
  const index: PriorOutputIndex = {};
  const artifactByAgent = new Map(input.children.map((child) => [child.id, child.outputArtifactId ?? `${child.id}_output`]));
  for (const artifact of input.artifacts) {
    const envelope = asRecord(artifact.envelope);
    const data = asRecord(envelope.data);
    const structuredOutput = extractStructuredOutputFromArtifact(data, artifact.body ?? (typeof envelope.body === "string" ? envelope.body : undefined))
      ?? extractStructuredOutputFromArtifact(envelope, artifact.body);
    const value = {
      ...envelope,
      structuredOutput: structuredOutput ?? asRecord(data.structuredOutput),
    };
    index[artifact.artifact_key] = value;
    if (artifact.agent_id) {
      index[artifact.agent_id] = value;
      index[`${artifact.agent_id}_output`] = value;
    }
  }
  for (const [agentId, artifactKey] of artifactByAgent) {
    if (artifactKey && index[artifactKey] && !index[agentId]) index[agentId] = index[artifactKey];
  }
  return index;
}

function sourceRootForBinding(input: {
  binding: HandoffBinding;
  priorOutputs: PriorOutputIndex;
  operatorInputs: Record<string, unknown>;
  stableConfig?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
}): unknown {
  const { binding } = input;
  if (binding.source.kind === "agent_output") {
    const agentId = binding.source.agentId ?? "";
    const prior = input.priorOutputs[agentId] ?? input.priorOutputs[`${agentId}_output`];
    const structured = asRecord(asRecord(prior).structuredOutput);
    return Object.keys(structured).length > 0 ? structured : prior;
  }
  if (binding.source.kind === "operator_input") {
    return binding.source.key ? input.operatorInputs[binding.source.key] : input.operatorInputs;
  }
  if (binding.source.kind === "stable_config") {
    return binding.source.key ? input.stableConfig?.[binding.source.key] : input.stableConfig;
  }
  if (binding.source.kind === "artifact") {
    return binding.source.key ? input.artifacts?.[binding.source.key] : input.artifacts;
  }
  return undefined;
}

export function resolveAgentHandoffBindings(input: {
  agent: { handoffBindings: HandoffBinding[] };
  priorOutputs: PriorOutputIndex;
  operatorInputs: Record<string, unknown>;
  stableConfig?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
}): {
  value: Record<string, unknown>;
  resolvedBindings: Array<{ targetPath: string; source: unknown; resolved: boolean; required: boolean }>;
  missingRequired: string[];
} {
  const value: Record<string, unknown> = {};
  const resolvedBindings: Array<{ targetPath: string; source: unknown; resolved: boolean; required: boolean }> = [];
  const missingRequired: string[] = [];
  for (const binding of input.agent.handoffBindings) {
    const sourceRoot = sourceRootForBinding({ ...input, binding });
    let resolved = readPath(sourceRoot, binding.source.path);
    if (!isPresent(resolved) && binding.source.kind === "agent_output") {
      const structured = asRecord(sourceRoot);
      if (binding.source.path === "/subject" && typeof structured.body === "string") {
        resolved = titleFromMarkdown(structured.body);
      } else if (binding.source.path === "/body" && typeof structured.text === "string") {
        resolved = structured.text;
      }
    }
    const ok = isPresent(resolved);
    resolvedBindings.push({
      targetPath: binding.targetPath,
      source: binding.source,
      resolved: ok,
      required: binding.required,
    });
    if (ok) writePath(value, binding.targetPath, resolved);
    else if (binding.required) missingRequired.push(binding.targetPath);
  }
  return { value, resolvedBindings, missingRequired };
}

import type { LoopArchitectOutput, NoSlopSpecSnapshot } from "./contracts.js";
import {
  connectorActionToolRef,
  getStaticToolContract,
  parseConnectorActionToolRef,
} from "../tool-spec/tool-contracts.js";
import {
  inferInputRequirementsForSpec,
  inferInputRequirementsFromPrompt,
} from "../loop-builder/intent-templates.js";
import {
  inputRequirementKeys,
  normalizeInputRequirements,
  canonicalizeInputRequirement,
  canonicalizeInputRequirementsList,
  extractInputRequirementContext,
  sanitizeInputRequirementsForDelivery,
  specRequiresRunStartContent,
  type InputRequirement,
} from "./input-surfaces.js";
import { isInputValidationAgent } from "../loop-runtime/memory.js";

function alignAgentPresentation(agent: LoopArchitectOutput["agents"][number]): LoopArchitectOutput["agents"][number] {
  let next = agent;
  if (next.renderTarget === "canvas.email" || next.renderTarget === "canvas.preview") {
    next = {
      ...next,
      outputContract: {
        ...next.outputContract,
        schema: {
          ...next.outputContract.schema,
          format: "email_markdown",
        },
      },
    };
  }
  if (next.gate?.type === "source_confirmation") {
    return { ...next, operatorSurface: "review.sources" };
  }
  if (next.gate?.type === "memory_confirmation") {
    return { ...next, operatorSurface: "review.memories" };
  }
  if (next.renderTarget === "canvas.email") {
    return { ...next, operatorSurface: "review.email" };
  }
  if (next.renderTarget === "canvas.preview") {
    return {
      ...next,
      operatorSurface: next.gate?.type === "pre_send" ? "confirm.send" : "review.preview",
    };
  }
  if (next.gate?.type === "draft_review" && !next.operatorSurface) {
    return { ...next, operatorSurface: "review.draft" };
  }
  return next;
}

/**
 * Deterministic repairs for common architect LLM mistakes that the critic always rejects.
 * Also injects an Input Validator agent when run_start inputRequirements require operator content.
 */
export function repairArchitectDesignForSpec(
  design: LoopArchitectOutput,
  noSlopSpec?: NoSlopSpecSnapshot,
): LoopArchitectOutput {
  const alignedDesign = {
    ...design,
    agents: design.agents.map(alignAgentPresentation),
  };
  if (!noSlopSpec) return alignedDesign;

  const writeActions = noSlopSpec.specJson.connectorPolicy.allowedWriteActions ?? [];
  const approvedWriteRefs = new Set(writeActions.map((action) => connectorActionToolRef(action).toLowerCase()));
  const soleWriteRef = writeActions.length === 1 ? connectorActionToolRef(writeActions[0]!) : null;

  const agents = alignedDesign.agents.map((agent) => {
    const contract = getStaticToolContract(agent.tool);
    let next = agent;

    if (next.gate?.type === "pre_send" && !contract?.approval.required) {
      next = {
        ...next,
        gate: { ...next.gate, type: "draft_review" },
      };
      next = alignAgentPresentation(next);
    }

    if (
      soleWriteRef
      && parseConnectorActionToolRef(agent.tool)
      && contract?.approval.required
      && !approvedWriteRefs.has(agent.tool.toLowerCase())
    ) {
      next = { ...next, tool: soleWriteRef };
    }

    return next;
  });

  let delivery = alignedDesign.delivery;
  if (soleWriteRef && delivery.target !== "none") {
    const provider = delivery.provider.toLowerCase();
    if (delivery.provider === "none" || !approvedWriteRefs.has(provider)) {
      delivery = { ...delivery, provider: soleWriteRef };
    }
  }

  return { ...alignedDesign, agents, delivery };
}

function mergeInputRequirements(
  design: LoopArchitectOutput,
  noSlopSpec: NoSlopSpecSnapshot | undefined,
  prompt: string,
): LoopArchitectOutput {
  const inferred = noSlopSpec
    ? inferInputRequirementsForSpec(noSlopSpec.specJson, prompt)
    : inferInputRequirementsFromPrompt(prompt);
  const context = noSlopSpec
    ? extractInputRequirementContext(noSlopSpec.specJson as unknown as Record<string, unknown>)
    : { recipientKind: "none", deliveryTarget: design.delivery.target ?? "none" };
  const specRequirements = sanitizeInputRequirementsForDelivery(
    canonicalizeInputRequirementsList(
      noSlopSpec?.specJson.inputRequirements ?? [],
      context,
    ),
    noSlopSpec?.specJson.delivery?.target ?? design.delivery.target ?? "none",
  );
  const mergedRaw = normalizeInputRequirements({
    inputRequirements: [
      ...specRequirements,
      ...(design.inputRequirements ?? []),
      ...inferred,
    ],
    inputsRequired: design.inputsRequired,
  });
  const merged = canonicalizeInputRequirementsList(mergedRaw, context);
  const deliveryTarget = noSlopSpec?.specJson.delivery?.target ?? design.delivery.target ?? "none";
  return {
    ...design,
    inputRequirements: sanitizeInputRequirementsForDelivery(merged, deliveryTarget),
    inputsRequired: inputRequirementKeys(sanitizeInputRequirementsForDelivery(merged, deliveryTarget)),
  };
}

function hasRunStartInputCollector(agents: LoopArchitectOutput["agents"]): boolean {
  return agents.some((agent) => isInputValidationAgent(agent) || agent.gate?.type === "missing_input");
}

function stripMissingInputFromSearchAgents(agents: LoopArchitectOutput["agents"]): LoopArchitectOutput["agents"] {
  return agents.map((agent) => {
    const contract = getStaticToolContract(agent.tool);
    const isSearchTool = agent.tool === "internal.web_search"
      || agent.tool === "internal.memory_search"
      || contract?.executionMode === "short_circuit";
    if (isSearchTool && agent.gate?.type === "missing_input") {
      const { gate: _gate, ...rest } = agent;
      return rest;
    }
    return agent;
  });
}

function buildInputValidatorAgent(keys: string[], requirements: InputRequirement[]): LoopArchitectOutput["agents"][number] {
  const keyList = keys.join(", ");
  const providedSchema = Object.fromEntries(keys.map((key) => [key, "string"]));
  const primary = requirements[0];
  const question = requirements.length === 1
    ? `Provide ${primary?.label ?? primary?.key.replace(/_/g, " ") ?? "required input"} to continue.`
    : "Provide the required inputs to continue.";
  return {
    id: "input_validator",
    name: "Input Validator",
    goal: `Collect and confirm required operator inputs (${keyList}) before downstream agents run.`,
    task: `Verify ${keyList} is present. Do not research, draft, or send.`,
    tool: "internal.llm_only",
    artifactRole: "source_evidence",
    inputContract: {
      description: "Operator-provided content inputs declared in inputRequirements",
      schema: { provided: providedSchema },
    },
    outputContract: {
      description: "Confirmation that required inputs are available for downstream agents",
      schema: { confirmed: "boolean", keys: "array" },
    },
    doneCriteria: [
      "Required operator inputs are present in run memory",
      "No placeholder or missing-input language in output",
    ],
    gate: { type: "missing_input", question },
  };
}

function stripRunStartContentWhenUnneeded(
  design: LoopArchitectOutput,
  noSlopSpec: NoSlopSpecSnapshot | undefined,
): LoopArchitectOutput {
  const needsRunStart = noSlopSpec
    ? specRequiresRunStartContent(noSlopSpec.specJson)
    : design.delivery.target === "team_email";
  if (needsRunStart) return design;

  const inputRequirements = (design.inputRequirements ?? []).filter((req) => req.when !== "run_start");
  const runStartKeys = new Set(
    (design.inputRequirements ?? []).filter((req) => req.when === "run_start").map((req) => req.key),
  );
  return {
    ...design,
    inputRequirements,
    inputsRequired: (design.inputsRequired ?? []).filter((key) => !runStartKeys.has(key)),
    agents: design.agents.filter((agent) => !isInputValidationAgent(agent)),
  };
}

function ensureInputValidatorAgent(design: LoopArchitectOutput): LoopArchitectOutput {
  const runStartRequirements = (design.inputRequirements ?? []).filter((req) => req.when === "run_start" && req.required);
  if (runStartRequirements.length === 0) {
    return { ...design, agents: stripMissingInputFromSearchAgents(design.agents) };
  }

  let agents = stripMissingInputFromSearchAgents(design.agents);
  if (hasRunStartInputCollector(agents)) {
    const collectorIndex = agents.findIndex((agent) => isInputValidationAgent(agent) || agent.gate?.type === "missing_input");
    if (collectorIndex > 0) {
      const [collector] = agents.splice(collectorIndex, 1);
      agents = [collector!, ...agents];
    }
    return { ...design, agents };
  }

  const keys = inputRequirementKeys(runStartRequirements);
  return {
    ...design,
    agents: [buildInputValidatorAgent(keys, runStartRequirements), ...agents],
  };
}

export function repairArchitectDesignForSpecWithInputs(
  design: LoopArchitectOutput,
  noSlopSpec: NoSlopSpecSnapshot | undefined,
  prompt: string,
): LoopArchitectOutput {
  const merged = mergeInputRequirements(repairArchitectDesignForSpec(design, noSlopSpec), noSlopSpec, prompt);
  const aligned = stripRunStartContentWhenUnneeded(merged, noSlopSpec);
  return ensureInputValidatorAgent(aligned);
}

import {
  noSlopSpecDraftSchema,
  type NoSlopSpec,
} from "../contracts/spec-contracts.js";
import type { LoopIntentContext } from "../contracts/intent-context.js";
import type { LoopBuildContract } from "../domain/build-contract.js";
import { availableToolsForSpecDraft } from "../services/discovery.service.js";
import {
  selectedLoopTrigger,
  selectedStableInputs,
} from "../domain/build-contract.js";
import { parseConnectorActionToolRef } from "../../tool-spec/tool-contracts.js";
import type { PlanContext } from "../plan/types.js";
import { buildConnectorPolicy } from "../plan/spec-compiler.js";

function inputRequirements(ctx: PlanContext): NoSlopSpec["inputRequirements"] {
  const requirements: NoSlopSpec["inputRequirements"] = [];
  for (const [name, value] of Object.entries(selectedStableInputs(ctx.buildContract))) {
    requirements.push({
      key: name,
      surface: "input.text",
      label: name.replace(/_/g, " "),
      required: true,
      when: "run_start",
      description: value,
    });
  }
  if (ctx.artifactBundle != null) {
    requirements.push({
      key: "artifact_template",
      surface: "input.markdown",
      label: "Artifact template",
      required: true,
      when: "run_start",
      description: "Structured artifact template selected during builder requirements.",
      value: ctx.artifactBundle,
    });
  }
  return requirements;
}

function schedule(buildContract: LoopBuildContract): NoSlopSpec["schedule"] {
  const trigger = selectedLoopTrigger(buildContract);
  if (trigger?.mode === "schedule") {
    return {
      description: `Approved schedule: ${trigger.cron} (${trigger.timezone})`,
      cron: trigger.cron,
      timezone: trigger.timezone,
    };
  }
  if (trigger?.mode === "event") {
    return { description: `Event-triggered via ${trigger.toolkit}:${trigger.triggerSlug}` };
  }
  return { description: "Runs on the approved trigger." };
}

function delivery(buildContract: LoopBuildContract, discoveredToolContracts: import("../../tool-spec/types.js").ToolContract[] = []): NoSlopSpec["delivery"] {
  const tools = availableToolsForSpecDraft(buildContract, discoveredToolContracts);
  const sendTool = tools.find((tool) =>
    tool.effect === "write_external" || tool.effect === "irreversible_external",
  );
  if (!sendTool) {
    return { provider: "none", description: "Dashboard only; no outbound delivery." };
  }
  const parsed = parseConnectorActionToolRef(sendTool.toolRef);
  const provider = parsed?.toolkit ?? sendTool.toolRef.replace(/^composio\.([^.]+)\.action\..+$/i, "$1");
  return { provider, description: `Deliver through ${sendTool.name}.` };
}

export function assembleSpec(
  ctx: PlanContext,
  agents: NoSlopSpec["agents"],
  intentContext?: LoopIntentContext,
): NoSlopSpec {
  const purpose = intentContext?.resolvedIntent?.trim() || ctx.purpose;
  const outcome = intentContext?.analysis.normalizedIntent.outcome ?? purpose;
  const approvalModel = intentContext?.analysis.normalizedIntent.approvalModel;
  const runtimeInputs = intentContext?.analysis.normalizedIntent.runtimeInputs ?? [];
  const doneCriteria = agents.flatMap((agent) => agent.doneWhen);

  return noSlopSpecDraftSchema.parse({
    purpose,
    agents,
    guardrails: [
      "Use finalizeAgent for structured step output; do not narrate tool calls in prose.",
      "Mutating external actions require operator approval gates.",
      ...(approvalModel && approvalModel !== "automatic" ? [`Approval model: ${approvalModel}.`] : []),
    ],
    successCriteria: doneCriteria.length > 0 ? doneCriteria : [outcome],
    failureModes: [
      "Pause for operator input when required context is missing.",
      "Do not proceed after a failed connector probe or missing approval.",
    ],
    schedule: schedule(ctx.buildContract),
    delivery: delivery(ctx.buildContract, ctx.discoveredToolContracts ?? []),
    connectorPolicy: buildConnectorPolicy(ctx.buildContract, approvalModel),
    inputRequirements: [
      ...inputRequirements(ctx),
      ...runtimeInputs.map((name) => ({
        key: name.toLowerCase().replace(/\s+/g, "_"),
        surface: "input.text" as const,
        label: name,
        required: true,
        when: "run_start" as const,
        description: `Runtime input: ${name}`,
      })),
    ],
  });
}

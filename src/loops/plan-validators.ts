import type { CompiledPlan } from "./spec.js";

export class CompiledPlanValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompiledPlanValidationError";
  }
}

export function assertAgenticCompiledPlan(plan: CompiledPlan): void {
  if (plan.profile !== "agentic") return;

  if (!plan.connectorPlaybook) {
    throw new CompiledPlanValidationError(
      "MISSING_CONNECTOR_PLAYBOOK",
      "Agentic plans require connectorPlaybook — recompile the loop",
    );
  }

  for (const tool of plan.toolCatalog) {
    if (!tool.plannerCard) {
      throw new CompiledPlanValidationError(
        "MISSING_PLANNER_CARD",
        `Tool ${tool.id} is missing plannerCard — recompile the loop`,
      );
    }
  }
}

export function validateAgenticCompileArtifacts(
  profile: CompiledPlan["profile"],
  toolCatalog: Array<{ id: string; plannerCard?: CompiledPlan["toolCatalog"][number]["plannerCard"] }>,
  connectorPlaybook?: CompiledPlan["connectorPlaybook"],
): Array<{ code: string; message: string }> {
  if (profile !== "agentic") return [];

  const errors: Array<{ code: string; message: string }> = [];
  if (!connectorPlaybook) {
    errors.push({
      code: "MISSING_CONNECTOR_PLAYBOOK",
      message: "Agentic compile requires a connector playbook from Composio",
    });
  }
  for (const tool of toolCatalog) {
    if (!tool.plannerCard) {
      errors.push({
        code: "MISSING_PLANNER_CARD",
        message: `Missing planner card for tool ${tool.id}`,
      });
    }
  }
  return errors;
}

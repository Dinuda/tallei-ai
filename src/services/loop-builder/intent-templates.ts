import type { InputRequirement } from "../loop-engine/input-surfaces.js";
import type { NoSlopSpec } from "../loop-engine/spec-contracts.js";
import { detectPlaceholderText } from "../loop-engine/contracts.js";

const PLACEHOLDER_INPUT_PATTERN = /\[(?:paste|tbd|todo|fill|insert)[^\]]*\]/i;

export function inferInputRequirementsFromPrompt(prompt: string): InputRequirement[] {
  const trimmed = prompt.trim();
  if (!trimmed || !PLACEHOLDER_INPUT_PATTERN.test(trimmed)) return [];

  if (/sprint|sync|weekly update|team email|internal email/i.test(trimmed)) {
    return [{
      key: "sprint_notes",
      surface: "input.markdown",
      label: "Sprint notes",
      description: "Paste sprint notes before drafting begins.",
      required: true,
      when: "run_start",
    }];
  }
  if (/newsletter|broadcast|subscriber|mailing list/i.test(trimmed)) {
    return [{
      key: "brief",
      surface: "input.markdown",
      label: "Newsletter brief",
      description: "Optional brief or outline for this edition.",
      required: false,
      when: "run_start",
    }];
  }
  return [{
    key: "source_content",
    surface: "input.markdown",
    label: "Source content",
    description: "Paste the content the loop should use before drafting.",
    required: true,
    when: "run_start",
  }];
}

export function inferInputRequirementsForSpec(
  spec: Pick<NoSlopSpec, "delivery" | "connectorPolicy" | "purpose">,
  prompt: string,
): InputRequirement[] {
  const fromPrompt = inferInputRequirementsFromPrompt(prompt);
  const requirements: InputRequirement[] = [...fromPrompt];

  const target = spec.delivery?.target ?? "none";
  const recipientKind = spec.connectorPolicy?.recipientSource?.kind ?? "none";
  if (target === "subscriber_list" && recipientKind !== "none") {
    if (recipientKind === "configured") {
      requirements.push({
        key: "audience_id",
        surface: "input.audience_id",
        label: "Audience or list ID",
        description: spec.connectorPolicy?.recipientSource?.description
          ?? "Provide the configured audience or list ID before sending.",
        required: true,
        when: "before_send",
      });
    } else {
      requirements.push({
        key: "recipients",
        surface: "input.contacts_csv",
        label: "Recipients",
        description: spec.connectorPolicy?.recipientSource?.description
          ?? "Upload or paste recipients before sending.",
        required: true,
        when: "before_send",
      });
    }
  }

  if (target === "team_email" && !requirements.some((req) => req.when === "run_start")) {
    requirements.push({
      key: "sprint_notes",
      surface: "input.markdown",
      label: "Team update notes",
      description: "Paste the notes for this internal sync email.",
      required: true,
      when: "run_start",
    });
  }

  return requirements;
}

export function promptHasPlaceholderInputs(prompt: string): boolean {
  return PLACEHOLDER_INPUT_PATTERN.test(prompt.trim()) || detectPlaceholderText(prompt);
}

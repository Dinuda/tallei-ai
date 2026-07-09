export const CONFIRM_OUTCOME_BRIEF_ACTIONS = [
  "confirm",
  "change_outcome",
  "change_trigger",
  "change_connectors",
  "change_approvals",
  "other",
] as const;

export type ConfirmOutcomeBriefAction = typeof CONFIRM_OUTCOME_BRIEF_ACTIONS[number];

export function parseConfirmOutcomeBriefAction(
  token: string,
): ConfirmOutcomeBriefAction | null {
  return (CONFIRM_OUTCOME_BRIEF_ACTIONS as readonly string[]).includes(token)
    ? token as ConfirmOutcomeBriefAction
    : null;
}

export function resolveConfirmOutcomeBriefActionFromSelection(input: {
  selectedOptionIds: string[];
  selectedValues: string[];
  options: Array<{ id: string; value: string }>;
}): ConfirmOutcomeBriefAction {
  const selectedOptions = input.options.filter((option) =>
    input.selectedOptionIds.includes(option.id),
  );

  for (const option of selectedOptions) {
    const fromId = parseConfirmOutcomeBriefAction(option.id);
    if (fromId) return fromId;
    const fromValue = parseConfirmOutcomeBriefAction(option.value);
    if (fromValue) return fromValue;
  }

  for (const value of input.selectedValues) {
    const parsed = parseConfirmOutcomeBriefAction(value);
    if (parsed) return parsed;
  }

  for (const id of input.selectedOptionIds) {
    const parsed = parseConfirmOutcomeBriefAction(id);
    if (parsed) return parsed;
  }

  return "other";
}

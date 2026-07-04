export const CONFIRM_OUTCOME_BRIEF_ACTIONS = [
    "confirm",
    "change_outcome",
    "change_trigger",
    "change_connectors",
    "change_approvals",
    "other",
];
export function parseConfirmOutcomeBriefAction(token) {
    return CONFIRM_OUTCOME_BRIEF_ACTIONS.includes(token)
        ? token
        : null;
}
export function resolveConfirmOutcomeBriefActionFromSelection(input) {
    const selectedOptions = input.options.filter((option) => input.selectedOptionIds.includes(option.id));
    for (const option of selectedOptions) {
        const fromId = parseConfirmOutcomeBriefAction(option.id);
        if (fromId)
            return fromId;
        const fromValue = parseConfirmOutcomeBriefAction(option.value);
        if (fromValue)
            return fromValue;
    }
    for (const value of input.selectedValues) {
        const parsed = parseConfirmOutcomeBriefAction(value);
        if (parsed)
            return parsed;
    }
    for (const id of input.selectedOptionIds) {
        const parsed = parseConfirmOutcomeBriefAction(id);
        if (parsed)
            return parsed;
    }
    return "other";
}
//# sourceMappingURL=confirm-outcome-brief-action.js.map
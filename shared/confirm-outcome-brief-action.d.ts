export declare const CONFIRM_OUTCOME_BRIEF_ACTIONS: readonly ["confirm", "change_outcome", "change_trigger", "change_connectors", "change_approvals", "other"];
export type ConfirmOutcomeBriefAction = typeof CONFIRM_OUTCOME_BRIEF_ACTIONS[number];
export declare function parseConfirmOutcomeBriefAction(token: string): ConfirmOutcomeBriefAction | null;
export declare function resolveConfirmOutcomeBriefActionFromSelection(input: {
    selectedOptionIds: string[];
    selectedValues: string[];
    options: Array<{
        id: string;
        value: string;
    }>;
}): ConfirmOutcomeBriefAction;
//# sourceMappingURL=confirm-outcome-brief-action.d.ts.map
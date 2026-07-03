import { z } from "zod";

import {
  CONFIRM_OUTCOME_BRIEF_ACTIONS,
  type ConfirmOutcomeBriefAction,
} from "../../shared/confirm-outcome-brief-action.js";

export {
  CONFIRM_OUTCOME_BRIEF_ACTIONS,
  type ConfirmOutcomeBriefAction,
  parseConfirmOutcomeBriefAction,
  resolveConfirmOutcomeBriefActionFromSelection,
} from "../../shared/confirm-outcome-brief-action.js";

export const confirmOutcomeBriefActionSchema = z.enum(CONFIRM_OUTCOME_BRIEF_ACTIONS);

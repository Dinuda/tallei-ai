import { defineSignal } from "@temporalio/workflow";

import type { ApprovalDecision } from "../types.js";

export const approvalDecisionSignal = defineSignal<[ApprovalDecision]>("approvalDecision");

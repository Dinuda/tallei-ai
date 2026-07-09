import type {
  AgentTeamReviewer,
  AgentTeamSpecialist,
  PresentAgentTeamOutput,
} from "./conductor-shared";

export function specialistDisplayName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

export type WorkflowReviewerContext = {
  reviewer?: AgentTeamReviewer;
  insertIndex: number;
  specialistsBefore: AgentTeamSpecialist[];
  specialistsAfter: AgentTeamSpecialist[];
};

export function splitSpecialistsAroundReviewer(
  team: PresentAgentTeamOutput | null | undefined,
): WorkflowReviewerContext {
  const specialists = team?.specialists ?? [];
  const insertIndex = team?.reviewer
    ? (team.reviewerInsertIndex ?? specialists.length)
    : specialists.length;

  return {
    reviewer: team?.reviewer,
    insertIndex,
    specialistsBefore: specialists.slice(0, insertIndex),
    specialistsAfter: specialists.slice(insertIndex),
  };
}
